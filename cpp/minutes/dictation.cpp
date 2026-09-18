#include "minutes/dictation.h"

#include <cctype>
#include <regex>
#include <vector>

namespace audionotes {

namespace {

struct Command {
  const char* pattern;  // whole words, case-insensitive
  const char* mark;
};

// Longest phrases first, so "exclamation mark" is not read as "mark".
const std::vector<Command>& commands() {
  static const std::vector<Command> c = {
      {"new paragraph", "\n\n"},
      {"new line", "\n"},
      {"full stop", "."},
      {"question mark", "?"},
      {"exclamation mark", "!"},
      {"exclamation point", "!"},
      {"comma", ","},
  };
  return c;
}

bool endsSentence(char ch) { return ch == '.' || ch == '?' || ch == '!'; }

}  // namespace

std::string applySpokenPunctuation(const std::string& text) {
  std::string out = text;
  bool any = false;
  for (const auto& cmd : commands()) {
    // Optional punctuation the recogniser attached before or after the command, and the spaces
    // around it, all go: "ready, full stop." -> "ready."
    const std::regex re("\\s*[,.;:]?\\s*\\b" + std::string(cmd.pattern) + "\\b[.,;:]?",
                        std::regex::icase);
    std::string next;
    std::sregex_iterator it(out.begin(), out.end(), re), end;
    std::size_t last = 0;
    for (; it != end; ++it) {
      any = true;
      next += out.substr(last, static_cast<std::size_t>(it->position()) - last);
      next += cmd.mark;
      last = static_cast<std::size_t>(it->position() + it->length());
    }
    next += out.substr(last);
    out = next;
  }
  if (!any) return text;

  // Tidy: a mark followed directly by a word needs one space (not after a line break); doubled
  // marks collapse; the first letter after a sentence mark or a line break is capitalised.
  std::string tidy;
  tidy.reserve(out.size() + 8);
  bool capitalise = true;
  for (std::size_t i = 0; i < out.size(); ++i) {
    char ch = out[i];
    if (ch == ' ' && !tidy.empty() && (tidy.back() == ' ' || tidy.back() == '\n')) continue;
    if ((endsSentence(ch) || ch == ',') && !tidy.empty() && tidy.back() == ' ') tidy.pop_back();
    if ((endsSentence(ch) || ch == ',') && !tidy.empty() && (endsSentence(tidy.back()) || tidy.back() == ',')) continue;
    if (ch == '\n' && !tidy.empty() && tidy.back() == ' ') tidy.pop_back();
    if (std::isalpha(static_cast<unsigned char>(ch)) && capitalise) {
      ch = static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
      capitalise = false;
    } else if (std::isalnum(static_cast<unsigned char>(ch))) {
      capitalise = false;
    }
    if (endsSentence(ch) || ch == '\n') capitalise = true;
    // A word straight after a mark gets its space back: "late?tell" -> "late? tell".
    if (!tidy.empty() && (endsSentence(tidy.back()) || tidy.back() == ',') &&
        std::isalnum(static_cast<unsigned char>(ch))) {
      tidy += ' ';
    }
    tidy += ch;
  }
  // No trailing space; a note that ended on a command keeps its mark.
  while (!tidy.empty() && tidy.back() == ' ') tidy.pop_back();
  return tidy;
}

}  // namespace audionotes
