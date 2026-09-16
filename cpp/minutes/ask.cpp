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
  return "Below are numbered passages from one meeting, and a question about it.\n\n"
         "PASSAGES:\n" + fenceTranscript(turns) + "\n"
         "QUESTION:\n" + fenceTranscript(question_text) + "\n"
         "Answer the question from the passages only, in at most three sentences. After each "
         "claim write the number of the passage it comes from in square brackets, like [2]. Do "
         "not add anything the passages do not say. If the passages do not answer the question, "
         "write exactly: " + std::string(kAskNothing) + "\n";
}

AskAnswer validateAnswer(const std::string& text, int n_passages) {
  AskAnswer out;
  out.nothing = false;
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
