#include "minutes/ask.h"

#include <cctype>
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
  out.nothing = out.cites.empty() || out.text.find(kAskNothing) != std::string::npos;
  return out;
}

}  // namespace audionotes
