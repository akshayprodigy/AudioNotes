// Parity port of src/pipeline/minutes.ts. Each pattern carries its JS original in a comment.
// Two deliberate departures forced by std::regex (see header/tests): the sentence splitter is
// hand-rolled (no lookbehind), and U+2019 is normalized to ' before matching (no multi-byte
// char classes). Everything else matches the JS byte-for-byte.
#include "minutes/minutes_extractor.h"

#include <algorithm>
#include <cctype>
#include <regex>
#include <unordered_map>
#include <unordered_set>

namespace audionotes {
namespace {

// JS: /\b(i['’]ll|i will|i am going to|i'm going to|let me|we['’]ll|we will|we need to|let['’]s)\b/i
const std::regex ACTION_FIRST_PERSON(
    R"rx(\b(i'll|i will|i am going to|i'm going to|let me|we'll|we will|we need to|let's)\b)rx",
    std::regex::icase);
// JS: /\b(can you|could you|would you|please|you need to|you should|make sure (you|to)|assign(ed)? to)\b/i
const std::regex ACTION_ASSIGN(
    R"rx(\b(can you|could you|would you|please|you need to|you should|make sure (you|to)|assign(ed)? to)\b)rx",
    std::regex::icase);
// JS: /\b(need to|needs to|have to|has to|must|should|going to|will send|will get|will do|follow[- ]?up|action item|to-?do)\b/i
const std::regex ACTION_OBLIGATION(
    R"rx(\b(need to|needs to|have to|has to|must|should|going to|will send|will get|will do|follow[- ]?up|action item|to-?do)\b)rx",
    std::regex::icase);
// JS: /\b(we decided|the decision|we agreed|agreed to|let['’]s go with|we['’]ll go with|we chose|going with|we['’]re going with|finali[sz]ed|sign(ed)? off|approved|conclusion is)\b/i
const std::regex DECISION(
    R"rx(\b(we decided|the decision|we agreed|agreed to|let's go with|we'll go with|we chose|going with|we're going with|finali[sz]ed|sign(ed)? off|approved|conclusion is)\b)rx",
    std::regex::icase);
// JS DUE regex, verbatim (only ['’] simplified):
const std::regex DUE(
    R"rx(\b(today|tonight|tomorrow|this (morning|afternoon|evening|week|month)|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|by (the )?(end of (the )?(day|week|month)|eod|cob|monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|\w+day)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in \d+ (day|days|week|weeks)|\d{1,2}(st|nd|rd|th)?( of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b)rx",
    std::regex::icase);
// JS: /\b([A-Z][a-z]{1,20})\s+(?:will|to|should|is going to|needs to|has to|can|could|please)\b/
// (case-SENSITIVE on purpose — capitalization is what marks a proper name)
const std::regex NAMED_OWNER(
    R"rx(\b([A-Z][a-z]{1,20})\s+(?:will|to|should|is going to|needs to|has to|can|could|please)\b)rx");
// JS: /^(what|why|how|when|where|who|which|should we|do we|can we|are we|is it|could we|would it)\b/i
const std::regex QUESTION_WORDS(
    R"rx(^(what|why|how|when|where|who|which|should we|do we|can we|are we|is it|could we|would it)\b)rx",
    std::regex::icase);
// JS: /^(I|We|You|The|This|That|It|Let|Please)$/  (case-sensitive)
const std::regex EXCLUDED_OWNER_WORDS(R"rx(^(I|We|You|The|This|That|It|Let|Please)$)rx");

const char* IMPERATIVE_VERBS[] = {
    "send", "prepare", "schedule", "email", "call", "review", "update", "create", "finish",
    "draft", "share", "set up", "book", "confirm", "check", "fix", "add", "remove", "ping",
};

// U+2019 (\xE2\x80\x99) -> ' so the patterns above can use plain apostrophes.
std::string normalizeApostrophes(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    if (i + 2 < s.size() && static_cast<unsigned char>(s[i]) == 0xE2 &&
        static_cast<unsigned char>(s[i + 1]) == 0x80 &&
        static_cast<unsigned char>(s[i + 2]) == 0x99) {
      out += '\'';
      i += 2;
    } else {
      out += s[i];
    }
  }
  return out;
}

std::string collapseWhitespace(const std::string& s) {
  std::string out;
  bool in_ws = false;
  for (char c : s) {
    if (std::isspace(static_cast<unsigned char>(c))) {
      in_ws = true;
    } else {
      if (in_ws && !out.empty()) out += ' ';
      in_ws = false;
      out += c;
    }
  }
  return out;
}

std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
  return s.substr(a, b - a);
}

// JS: text.replace(/\s+/g,' ').split(/(?<=[.!?])\s+/).map(trim).filter(Boolean)
// Hand-rolled: after whitespace collapse, break after [.!?] followed by a space.
std::vector<std::string> splitSentences(const std::string& text) {
  const std::string t = collapseWhitespace(text);
  std::vector<std::string> out;
  std::string cur;
  for (size_t i = 0; i < t.size(); ++i) {
    cur += t[i];
    if ((t[i] == '.' || t[i] == '!' || t[i] == '?') && i + 1 < t.size() && t[i + 1] == ' ') {
      std::string s = trim(cur);
      if (!s.empty()) out.push_back(s);
      cur.clear();
      ++i;  // consume the space
    }
  }
  std::string s = trim(cur);
  if (!s.empty()) out.push_back(s);
  return out;
}

// JS: s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
std::string norm(const std::string& s) {
  std::string lowered;
  lowered.reserve(s.size());
  for (char c : s) lowered += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  std::string out;
  bool in_run = false;
  for (char c : lowered) {
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      in_run = false;
      out += c;
    } else if (!in_run) {
      in_run = true;
      out += ' ';
    }
  }
  return trim(out);
}

bool startsWithImperative(const std::string& sentence) {
  std::string first = trim(sentence);
  for (char& c : first) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  for (const char* v : IMPERATIVE_VERBS) {
    if (first.rfind(std::string(v) + " ", 0) == 0) return true;
  }
  return false;
}

std::string detectOwner(const std::string& sentence, const std::string& speaker_name) {
  std::smatch m;
  if (std::regex_search(sentence, m, NAMED_OWNER)) {
    const std::string n = m[1].str();
    if (!std::regex_match(n, EXCLUDED_OWNER_WORDS)) return n;
  }
  if (std::regex_search(sentence, ACTION_FIRST_PERSON) && !speaker_name.empty()) return speaker_name;
  if (std::regex_search(sentence, ACTION_ASSIGN)) return "Unassigned";
  return "Unassigned";
}

bool isAction(const std::string& sentence) {
  return std::regex_search(sentence, ACTION_FIRST_PERSON) ||
         std::regex_search(sentence, ACTION_ASSIGN) ||
         std::regex_search(sentence, ACTION_OBLIGATION) || startsWithImperative(sentence);
}

bool isQuestion(const std::string& sentence) {
  const std::string t = trim(sentence);
  if (!t.empty() && t.back() == '?') return true;
  return std::regex_search(t, QUESTION_WORDS) && t.size() < 160;
}

}  // namespace

std::vector<DraftMinute> extractMinutes(const std::vector<MinuteUtt>& utterances,
                                        const std::vector<MinuteSpk>& speakers) {
  std::unordered_map<std::string, std::string> name_by_id;
  for (const auto& s : speakers) name_by_id[s.id] = s.display_name;

  std::vector<DraftMinute> actions, decisions, questions;
  std::unordered_set<std::string> seen;

  auto add = [&seen](std::vector<DraftMinute>& arr, const std::string& kind,
                     const std::string& content) {
    const std::string key = kind + "|" + norm(content);
    if (content.empty() || seen.count(key)) return;
    seen.insert(key);
    arr.push_back({kind, content, "rule"});
  };

  for (const auto& u : utterances) {
    std::string speaker_name;
    if (!u.speaker_id.empty()) {
      auto it = name_by_id.find(u.speaker_id);
      if (it != name_by_id.end()) speaker_name = it->second;
    }

    for (const auto& sentence : splitSentences(normalizeApostrophes(u.text))) {
      if (sentence.size() < 4) continue;

      if (isQuestion(sentence)) {
        add(questions, "question", sentence);
        continue;  // a question is not also an action
      }
      if (std::regex_search(sentence, DECISION)) {
        add(decisions, "decision", sentence);
        continue;
      }
      if (isAction(sentence)) {
        const std::string owner = detectOwner(sentence, speaker_name);
        std::smatch due;
        std::string content = sentence + " \xE2\x80\x94 " + owner;  // " — <owner>"
        if (std::regex_search(sentence, due, DUE)) content += " (due " + due[0].str() + ")";
        add(actions, "action", content);
      }
    }
  }

  if (actions.size() > 30) actions.resize(30);
  if (decisions.size() > 20) decisions.resize(20);
  if (questions.size() > 20) questions.resize(20);

  DraftMinute summary{
      "summary",
      std::to_string(actions.size()) + " action item" + (actions.size() == 1 ? "" : "s") + ", " +
          std::to_string(decisions.size()) + " decision" + (decisions.size() == 1 ? "" : "s") +
          ", " + std::to_string(questions.size()) + " open question" +
          (questions.size() == 1 ? "" : "s") + ".",
      "rule"};

  std::vector<DraftMinute> out;
  out.push_back(summary);
  out.insert(out.end(), decisions.begin(), decisions.end());
  out.insert(out.end(), actions.begin(), actions.end());
  out.insert(out.end(), questions.begin(), questions.end());
  return out;
}

}  // namespace audionotes
