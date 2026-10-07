#include "minutes/ask.h"

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "minutes/fence.h"

namespace audionotes {

const char* const kAskNothing = "Nothing in this meeting settles that.";

namespace {

// m:ss, or h:mm:ss past an hour — the same shape provenanceLabel shows on screen, so the number
// the model cites is the number the person sees.
std::string stampOf(long ms) {
  if (ms < 0) ms = 0;
  const long s = ms / 1000;
  const long h = s / 3600, m = (s % 3600) / 60, sec = s % 60;
  char buf[32];
  if (h > 0) {
    std::snprintf(buf, sizeof buf, "%ld:%02ld:%02ld", h, m, sec);
  } else {
    std::snprintf(buf, sizeof buf, "%ld:%02ld", m, sec);
  }
  return buf;
}

}  // namespace

std::string askPrompt(const std::string& question, const std::vector<AskPassage>& passages) {
  std::string turns;
  for (size_t i = 0; i < passages.size(); ++i) {
    const auto& p = passages[i];
    turns += "[" + std::to_string(i + 1) + "] " + p.speaker + " (" + stampOf(p.start_ms) + "): " + p.text + "\n";
  }
  const std::string question_text = question;
  // One worked example, on another subject. Without it the 1.5B writer copied the passages back
  // out before answering (measured on the Pixel, 17 Sep) — the same failure the classifier had
  // until its prompt carried examples: a small model told the SHAPE of an answer still needs to
  // be shown one.
  return "Below are numbered passages from one meeting, and a question about it. Answer the "
         "question in at most three sentences, from the passages only, and after each claim "
         "write the number of the passage it comes from in square brackets. Do not repeat the "
         "passages. Do not add anything they do not say. If they do not answer the question, "
         "write exactly: " + std::string(kAskNothing) + "\n\n"
         "Example.\n"
         "[1] Dev (0:12): Sam, can you send the report by Friday?\n"
         "[2] Sam (0:15): No, Friday is impossible, the data only comes in on Monday.\n"
         "Question: when will the report be ready?\n"
         "Answer: Not by Friday; Sam said the data only arrives on Monday [2].\n\n"
         "Now the real one.\n"
         "PASSAGES:\n" + fenceTranscript(turns) + "\n"
         "QUESTION:\n" + fenceTranscript(question_text) + "\n"
         "Answer:\n";
}

std::string askGrammar(int n_passages) {
  int n = n_passages < 1 ? 1 : (n_passages > 9 ? 9 : n_passages);
  std::string digits = "[1-" + std::to_string(n) + "]";
  if (n == 1) digits = "\"1\"";
  return "root ::= nothing | answer\n"
         "nothing ::= \"" + std::string(kAskNothing) + "\"\n"
         "answer ::= body cite+\n"
         "body ::= [^\\[\\]\\n]{1,400}\n"
         "cite ::= \" [\" " + digits + " \"]\"\n";
}

namespace {

// A line that is one of the passages copied back out: "[n] Name (m:ss): …". The model was handed
// these; it is not answering by repeating them.
bool isEchoedPassage(const std::string& line) {
  size_t i = 0;
  while (i < line.size() && std::isspace(static_cast<unsigned char>(line[i]))) ++i;
  if (i >= line.size() || line[i] != '[') return false;
  size_t j = i + 1;
  while (j < line.size() && std::isdigit(static_cast<unsigned char>(line[j]))) ++j;
  if (j == i + 1 || j >= line.size() || line[j] != ']') return false;
  // "[n] " then a speaker, then " (m:ss): " — the stamp in parentheses followed by a colon.
  const size_t paren = line.find(" (", j);
  if (paren == std::string::npos) return false;
  const size_t close = line.find("):", paren);
  if (close == std::string::npos) return false;
  bool digits = false;
  for (size_t k = paren + 2; k < close; ++k) {
    const char c = line[k];
    if (std::isdigit(static_cast<unsigned char>(c))) digits = true;
    else if (c != ':') return false;
  }
  return digits;
}

std::string withoutEchoes(const std::string& text) {
  std::string out;
  size_t start = 0;
  while (start <= text.size()) {
    size_t nl = text.find('\n', start);
    const std::string line = text.substr(start, nl == std::string::npos ? std::string::npos : nl - start);
    if (!isEchoedPassage(line)) {
      out += line;
      if (nl != std::string::npos) out += '\n';
    }
    if (nl == std::string::npos) break;
    start = nl + 1;
  }
  return out;
}


// ---- The per-sentence cite rule (F17) ---------------------------------------------------------
//
// The grammar is `body cite+`, so a cited answer can still carry a sentence nothing supports:
// "Priya agreed. The budget is fixed. [2]". The cite at the end is the model pointing; the first
// sentence is the model asserting. The grammar stays as it is (it is constrained decoding and a
// change there is risky); this is the post-hoc half: after generation, every sentence that carries
// no valid [n] is dropped, and if none survives the answer is "nothing".

// Words whose trailing '.' does not end a sentence, compared lowercase without the dot.
bool isAbbreviation(const std::string& word) {
  static const char* const kAbbr[] = {"mr", "mrs", "ms", "dr", "prof", "st", "vs", "etc", "e.g", "i.e", "no", "approx"};
  std::string w;
  for (char c : word) w += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  for (const char* a : kAbbr)
    if (w == a) return true;
  return false;
}

// Index just past a "[n]" cite at `i` (digits only), or `i` when there is none.
size_t citeEnd(const std::string& t, size_t i) {
  if (i >= t.size() || t[i] != '[') return i;
  size_t j = i + 1;
  while (j < t.size() && std::isdigit(static_cast<unsigned char>(t[j]))) ++j;
  return (j > i + 1 && j < t.size() && t[j] == ']') ? j + 1 : i;
}

// The sentences of `t`, each as the exact substring, in order. A sentence ends at '.', '!' or '?'
// followed by whitespace or the end, or at a newline. Cites written AFTER the full stop ("…Monday.
// [2]") belong to the sentence before them: the grammar puts every cite at the very end, so
// without this the last claim would be stranded from the number that supports it.
std::vector<std::string> sentencesOf(const std::string& t) {
  std::vector<std::string> out;
  size_t start = 0, i = 0;
  auto push = [&](size_t end) {
    size_t a = start, b = end;
    while (a < b && std::isspace(static_cast<unsigned char>(t[a]))) ++a;
    while (b > a && std::isspace(static_cast<unsigned char>(t[b - 1]))) --b;
    if (b > a) out.push_back(t.substr(a, b - a));
    start = end;
  };
  while (i < t.size()) {
    const char c = t[i];
    if (c == '\n') {
      push(i);
      ++i;
      continue;
    }
    if (c == '.' || c == '!' || c == '?') {
      size_t j = i + 1;
      while (j < t.size() && (t[j] == '.' || t[j] == '!' || t[j] == '?')) ++j;
      const bool boundary = j >= t.size() || std::isspace(static_cast<unsigned char>(t[j]));
      if (boundary && c == '.') {
        // "Dr." / "Mr." and friends: the word before the dot.
        size_t w = i;
        while (w > start && !std::isspace(static_cast<unsigned char>(t[w - 1]))) --w;
        if (isAbbreviation(t.substr(w, i - w))) {
          i = j;
          continue;
        }
      }
      if (boundary) {
        // Absorb trailing cites: ". [2]" and ".[2][1]".
        size_t k = j;
        for (;;) {
          size_t m = k;
          while (m < t.size() && t[m] == ' ') ++m;
          const size_t e = citeEnd(t, m);
          if (e == m) break;
          k = e;
        }
        push(k);
        i = k;
        continue;
      }
      i = j;
      continue;
    }
    ++i;
  }
  push(t.size());
  return out;
}

bool hasCite(const std::string& sentence) {
  for (size_t i = 0; i < sentence.size(); ++i)
    if (citeEnd(sentence, i) != i) return true;
  return false;
}

// Appends the in-range cites of `sentence` to `cites`, unique, first-mention order.
void collectCites(const std::string& sentence, std::vector<int>& cites) {
  for (size_t i = 0; i < sentence.size(); ++i) {
    const size_t e = citeEnd(sentence, i);
    if (e == i) continue;
    const int n = std::atoi(sentence.substr(i + 1, e - i - 2).c_str());
    bool seen = false;
    for (int c : cites) seen = seen || c == n;
    if (!seen) cites.push_back(n);
    i = e - 1;
  }
}

}  // namespace

AskAnswer validateAnswer(const std::string& raw, int n_passages) {
  AskAnswer out;
  out.nothing = false;
  const std::string text = withoutEchoes(raw);
  std::string kept;
  kept.reserve(text.size());
  size_t i = 0;
  while (i < text.size()) {
    if (text[i] == '[') {
      size_t j = i + 1;
      while (j < text.size() && std::isdigit(static_cast<unsigned char>(text[j]))) ++j;
      if (j > i + 1 && j < text.size() && text[j] == ']') {
        const int n = std::atoi(text.substr(i + 1, j - i - 1).c_str());
        if (n >= 1 && n <= n_passages) {
          bool seen = false;
          for (int c : out.cites) seen = seen || c == n;
          if (!seen) out.cites.push_back(n);
          kept.append(text, i, j - i + 1);
        } else if (!kept.empty() && kept.back() == ' ') {
          kept.pop_back();  // "Friday [9]," → "Friday,"
        }
        i = j + 1;
        continue;
      }
    }
    kept += text[i];
    ++i;
  }
  // Trim.
  size_t a = 0, b = kept.size();
  while (a < b && std::isspace(static_cast<unsigned char>(kept[a]))) ++a;
  while (b > a && std::isspace(static_cast<unsigned char>(kept[b - 1]))) --b;
  out.text = kept.substr(a, b - a);
  const bool refusal = out.text.find(kAskNothing) != std::string::npos;

  // The per-sentence rule: keep only the sentences that carry a valid cite, and take the cite list
  // from what is left, so a number cited only by a dropped sentence cannot survive it.
  std::string survived;
  std::vector<int> cites;
  for (const auto& sentence : sentencesOf(out.text)) {
    if (!hasCite(sentence)) continue;
    if (!survived.empty()) survived += ' ';
    survived += sentence;
    collectCites(sentence, cites);
  }
  out.text = survived;
  out.cites = cites;
  out.nothing = out.cites.empty() || refusal;
  return out;
}

}  // namespace audionotes
