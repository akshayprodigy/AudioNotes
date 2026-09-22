#include "minutes/templates.h"

#include <algorithm>
#include <cctype>
#include <unordered_map>
#include <vector>

namespace audionotes {

const char* const kTemplateIds[7] = {
    "general", "standup", "one_on_one", "client", "interview", "lecture", "site_walk",
};

namespace {

// Section names, in the order the narrative should cover them. Every string here is also what
// the narrator opens a paragraph with, followed by a colon — see the coverage instruction built
// in narrativePrompt (llm_prompts.cpp).
const std::unordered_map<std::string, std::vector<std::string>>& sectionTable() {
  static const std::unordered_map<std::string, std::vector<std::string>> table = {
      {"standup", {"Done since last time", "Planned next", "Blockers"}},
      {"one_on_one", {"Topics raised", "Agreed", "Follow-ups"}},
      {"client",
       {"What the client asked for", "What we committed to", "Risks and open points",
        "Next steps"}},
      {"interview",
       {"Background", "Questions and answers", "Strengths", "Concerns", "Next step"}},
      {"lecture", {"Key points", "Definitions and terms", "Questions raised", "To read or do"}},
      {"site_walk", {"Observations", "Issues found", "Actions agreed"}},
  };
  return table;
}

}  // namespace

std::vector<std::string> sectionsFor(const std::string& template_id) {
  const auto& table = sectionTable();
  const auto it = table.find(template_id);
  if (it == table.end()) return {};
  return it->second;
}

namespace {

std::string trimmed(const std::string& s) {
  const std::size_t a = s.find_first_not_of(" \t\r\n");
  if (a == std::string::npos) return "";
  const std::size_t b = s.find_last_not_of(" \t\r\n");
  return s.substr(a, b - a + 1);
}

std::string lowered(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

// The section this line is the bare header of, or -1. "blockers", "Blockers:", "BLOCKERS :" all
// count; "Blockers: the phone is with QA." does not — that is the shape wanted, left alone.
int headerIndex(const std::string& line, const std::vector<std::string>& sections) {
  std::string t = trimmed(line);
  if (!t.empty() && t.back() == ':') t = trimmed(t.substr(0, t.size() - 1));
  const std::string lt = lowered(t);
  for (std::size_t i = 0; i < sections.size(); ++i) {
    if (lt == lowered(sections[i])) return static_cast<int>(i);
  }
  return -1;
}

// A bullet or numbered-list marker at the start of a line, removed; the fragment capitalised and
// ended with a full stop when it has no end of its own.
std::string fragment(const std::string& line) {
  std::string t = trimmed(line);
  if (t.size() >= 2 && (t[0] == '-' || t[0] == '*' || t[0] == '+') && t[1] == ' ') t = trimmed(t.substr(2));
  else if (t.rfind("\xE2\x80\xA2", 0) == 0) t = trimmed(t.substr(3));  // "•"
  else {
    std::size_t i = 0;
    while (i < t.size() && std::isdigit(static_cast<unsigned char>(t[i]))) ++i;
    if (i > 0 && i < t.size() && (t[i] == '.' || t[i] == ')') && i + 1 < t.size() && t[i + 1] == ' ') {
      t = trimmed(t.substr(i + 2));
    }
  }
  if (t.empty()) return t;
  t[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(t[0])));
  const char last = t.back();
  if (last != '.' && last != '!' && last != '?' && last != ':' && last != ';' && last != ',') t += '.';
  return t;
}

}  // namespace

namespace {
bool isBullet(const std::string& line) {
  const std::string t = trimmed(line);
  if (t.size() >= 2 && (t[0] == '-' || t[0] == '*' || t[0] == '+') && t[1] == ' ') return true;
  if (t.rfind("\xE2\x80\xA2", 0) == 0) return true;
  std::size_t i = 0;
  while (i < t.size() && std::isdigit(static_cast<unsigned char>(t[i]))) ++i;
  return i > 0 && i + 1 < t.size() && (t[i] == '.' || t[i] == ')') && t[i + 1] == ' ';
}

// A section label that begins inside a line rather than at the start of one: "<Name>:" preceded
// by a space, and before that the end of a sentence. The 1.5B writer does this with the longer
// section lists — a client call came back on the A07 as one paragraph holding all four (22 Sep),
// where the stand-up's three arrived on lines of their own.
//
// Returns the byte offsets at which `line` should be cut, in order, never including 0.
std::vector<std::size_t> inlineLabelCuts(const std::string& line,
                                         const std::vector<std::string>& sections) {
  std::vector<std::size_t> cuts;
  const std::string low = lowered(line);
  for (const auto& name : sections) {
    const std::string needle = lowered(name) + ":";
    for (std::size_t at = low.find(needle); at != std::string::npos;
         at = low.find(needle, at + 1)) {
      if (at == 0) continue;                       // already opens its line: the existing shape
      if (line[at - 1] != ' ') continue;           // "…and what we committed to:" is not a label
      std::size_t before = at - 1;
      while (before > 0 && line[before] == ' ') --before;
      const char end = line[before];
      if (end != '.' && end != '!' && end != '?') continue;  // mid-sentence: leave it alone
      cuts.push_back(at);
    }
  }
  std::sort(cuts.begin(), cuts.end());
  cuts.erase(std::unique(cuts.begin(), cuts.end()), cuts.end());
  return cuts;
}
}  // namespace

std::string foldDictation(const std::string& text) {
  std::vector<std::string> lines;
  for (std::size_t start = 0;;) {
    const std::size_t nl = text.find('\n', start);
    if (nl == std::string::npos) { lines.push_back(text.substr(start)); break; }
    lines.push_back(text.substr(start, nl - start));
    start = nl + 1;
  }
  // The opening label: "The note for Priya:" becomes the first sentence rather than a line
  // stripLabels drops.
  bool touched = false;
  for (auto& l : lines) {
    std::string t = trimmed(l);
    if (t.empty()) continue;
    if (t.back() == ':' && t.size() <= 60 && !isBullet(t)) { t.back() = '.'; l = t; touched = true; }
    break;
  }
  // Bullets: the writer lists a dictated note when its sentences are short. Consecutive bullet
  // lines become one paragraph of sentences, the marker gone, each fragment ended.
  std::vector<std::string> out;
  std::string para;
  auto flush = [&]() { if (!para.empty()) { out.push_back(para); para.clear(); } };
  for (const auto& l : lines) {
    if (isBullet(l)) {
      touched = true;
      const std::string f = fragment(l);
      if (f.empty()) continue;
      if (!para.empty()) para += ' ';
      para += f;
    } else {
      flush();
      out.push_back(l);
    }
  }
  flush();
  if (!touched) return text;
  std::string joined;
  for (std::size_t i = 0; i < out.size(); ++i) {
    if (i) joined += '\n';
    joined += out[i];
  }
  return joined;
}

std::string foldSections(const std::string& text, const std::string& template_id) {
  if (template_id == "dictation") return foldDictation(text);
  const auto sections = sectionsFor(template_id);
  if (sections.empty()) return text;

  std::vector<std::string> lines;
  for (std::size_t start = 0;;) {
    const std::size_t nl = text.find('\n', start);
    if (nl == std::string::npos) { lines.push_back(text.substr(start)); break; }
    lines.push_back(text.substr(start, nl - start));
    start = nl + 1;
  }

  // Nothing to fold: the text is returned byte for byte, so a narrative already in shape (or
  // one with no headers at all) is untouched, blank lines and all.
  bool anyHeader = false;
  for (const auto& l : lines) if (headerIndex(l, sections) >= 0) { anyHeader = true; break; }
  if (!anyHeader) {
    // No header on a line of its own. The writer may still have put the labels inside the prose;
    // two or more of them is a shape, one is a sentence. Each piece becomes its own paragraph,
    // opened by the canonical section name so the casing matches the folded path.
    std::vector<std::string> pieces;
    for (const auto& l : lines) {
      const auto cuts = inlineLabelCuts(l, sections);
      std::size_t from = 0;
      for (const std::size_t at : cuts) {
        pieces.push_back(trimmed(l.substr(from, at - from)));
        from = at;
      }
      pieces.push_back(trimmed(l.substr(from)));
    }
    std::size_t labelled = 0;
    for (const auto& p : pieces) {
      for (const auto& name : sections) {
        if (lowered(p).rfind(lowered(name) + ":", 0) == 0) { ++labelled; break; }
      }
    }
    if (labelled < 2) return text;
    std::string out;
    for (std::size_t i = 0; i < pieces.size(); ++i) {
      if (pieces[i].empty()) continue;
      if (!out.empty()) out += "\n\n";
      // Canonical casing for the label, the rest of the piece as written.
      bool named = false;
      for (const auto& name : sections) {
        const std::string needle = lowered(name) + ":";
        if (lowered(pieces[i]).rfind(needle, 0) == 0) {
          out += name + ":" + pieces[i].substr(needle.size());
          named = true;
          break;
        }
      }
      if (!named) out += pieces[i];
    }
    return out;
  }

  std::vector<std::string> paragraphs;
  std::string before;    // the lines before the first header, verbatim
  std::string current;   // the paragraph being folded, "" when not inside a section
  bool inSection = false;
  for (const auto& l : lines) {
    const int h = headerIndex(l, sections);
    if (h >= 0) {
      if (inSection) paragraphs.push_back(current);
      else if (!trimmed(before).empty()) paragraphs.push_back(trimmed(before));
      current = sections[static_cast<std::size_t>(h)] + ":";
      inSection = true;
      continue;
    }
    if (!inSection) { before += l; before += '\n'; continue; }
    const std::string f = fragment(l);
    if (f.empty()) continue;
    current += ' ';
    current += f;
  }
  if (inSection) paragraphs.push_back(current);

  std::string out;
  for (std::size_t i = 0; i < paragraphs.size(); ++i) {
    if (i) out += "\n\n";
    out += paragraphs[i];
  }
  return out;
}

}  // namespace audionotes
