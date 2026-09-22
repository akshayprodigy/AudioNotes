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
// JS: /\b(need to|needs to|have to|has to|must|should|going to|will (<verb list>)|follow[- ]?up|action item|to-?do)\b/i
// `will <verb>`, never bare `will`: see src/pipeline/minutes.ts for the sentence that forced it.
const std::regex ACTION_OBLIGATION(
    R"rx(\b(need to|needs to|have to|has to|must|should|going to|will (send|get|do|prepare|schedule|email|call|review|update|create|finish|draft|share|set up|book|confirm|check|fix|add|remove|ping|write|handle|arrange|circulate|deliver|submit|publish|post|present|report|test|deploy|release|ship|record|contact|notify|remind|invite|organi[sz]e|look into|follow up|reach out|take care|sort out|own|lead|start|complete)|follow[- ]?up|action item|to-?do)\b)rx",
    std::regex::icase);
// JS: /\b(we decided|we have decided|we['’]ve decided|it was decided|it['’]s been decided|decided (that|to)|the decision|decision (is|was)|we agreed|agreed (to|that)|let['’]s go with|we['’]ll go with|we chose|going with|we['’]re going with|finali[sz]ed|sign(ed)? off|approved|conclusion is)\b/i
const std::regex DECISION(
    R"rx(\b(we decided|we have decided|we've decided|it was decided|it's been decided|decided (that|to)|the decision|decision (is|was)|we agreed|agreed (to|that)|let's go with|we'll go with|we chose|going with|we're going with|finali[sz]ed|sign(ed)? off|approved|conclusion is)\b)rx",
    std::regex::icase);
// JS: SCHEDULE_VERB / SCHEDULE_WHEN / SCHEDULE_INTENT in src/pipeline/minutes.ts. Verb and time
// must both be in the sentence and the intent phrasing must not be; see the JS comment for why
// the bare infinitive is in the list (whisper drops the "-d" of "moved to" before the /t/).
const std::regex SCHEDULE_VERB(
    R"rx(\b(move|moves|moved|push|pushes|pushed|postpone|postpones|postponed|delay|delays|delayed|reschedule|reschedules|rescheduled|shift|shifts|shifted|slip|slips|slipped|bump|bumps|bumped|bring forward|brings forward|brought forward|pull forward|pulls forward|pulled forward|put back|puts back)\b)rx",
    std::regex::icase);
const std::regex SCHEDULE_WHEN(
    R"rx(\b(to|till|until|into|for)\s+(the\s+)?(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next (week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (week|month|morning|afternoon|evening)|the (end of (the )?(day|week|month)|weekend)|q[1-4]|\d{1,2}(st|nd|rd|th)?( of)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2})\b)rx",
    std::regex::icase);
// JS: SCHEDULE_INTENT (only ['’] simplified) — the verb as an intention, which is an action.
const std::regex SCHEDULE_INTENT(
    R"rx(\b(to|must|should|shall|will|would|can|could|may|might|let's|please)\s+(you |we |i |they |he |she |it )?(move|push|postpone|delay|reschedule|shift|bump|bring forward|pull forward|put back)\b)rx",
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

bool startsWithImperative(const std::string& sentence) {
  std::string first = trim(sentence);
  for (char& c : first) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  for (const char* v : IMPERATIVE_VERBS) {
    if (first.rfind(std::string(v) + " ", 0) == 0) return true;
  }
  return false;
}

}  // namespace

// The rules themselves. Named rather than file-private so evidence.cpp can add provenance
// to the same rules instead of restating them — a second copy of these would be a second
// thing to keep in step with minutes.ts. Declared in the header; see the note there.
namespace rules {

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

// JS: /[A-Za-z0-9]+/g counted over the trimmed sentence. ASCII on purpose — see the JS comment.
int asciiWordCount(const std::string& s) {
  int n = 0;
  bool in_word = false;
  for (unsigned char c : s) {
    const bool w = c < 128 && std::isalnum(c) != 0;
    if (w && !in_word) ++n;
    in_word = w;
  }
  return n;
}

bool isQuestion(const std::string& sentence) {
  const std::string t = trim(sentence);
  const bool asked = (!t.empty() && t.back() == '?') ||
                     (std::regex_search(t, QUESTION_WORDS) && t.size() < 160);
  if (!asked) return false;
  const int words = asciiWordCount(t);
  return words == 0 || words >= 3;
}

// JS: DECISION.test(sentence) at the extractMinutes/extractItems call site. A wrapper, not a
// second copy of the pattern: DECISION itself stays private to this file so there is exactly one
// place it can drift.
bool isDecision(const std::string& sentence) {
  if (std::regex_search(sentence, DECISION)) return true;
  return std::regex_search(sentence, SCHEDULE_VERB) && std::regex_search(sentence, SCHEDULE_WHEN) &&
         !std::regex_search(sentence, SCHEDULE_INTENT);
}

// JS: sentence.match(DUE) — `*out` receives match[0], the whole matched phrase, which is what
// both extractors interpolate into "(due ...)".
bool matchDue(const std::string& sentence, std::string* out) {
  std::smatch m;
  if (!std::regex_search(sentence, m, DUE)) return false;
  if (out) *out = m[0].str();
  return true;
}

}  // namespace rules

namespace {

// ---- The free-tier summary ------------------------------------------------------------------
//
// Parity port of composeSummary() in src/pipeline/minutes.ts. These rows are what the device
// actually writes, so this — not the JS — is the paragraph a free user exports and forwards.

// How many items the overview quotes before it stops being an overview.
constexpr size_t LEAD_DECISIONS = 2;
constexpr size_t LEAD_ACTIONS = 3;
// Rule items are whole sentences lifted from the transcript, and people speak in long ones.
constexpr size_t LEAD_ITEM_CHARS = 160;

// detectOwner writes this exact word when it cannot find a name, so the check is a substring.
const char* const UNASSIGNED = " \xE2\x80\x94 Unassigned";  // " — Unassigned"

/**
 * The length JavaScript would report: UTF-16 code units, not bytes and not codepoints.
 *
 * `leadItem` clips at 160 *characters*, and the strings being clipped are full of em dashes and
 * curly quotes — three bytes each, one unit each. Counting bytes would clip a different sentence
 * here than in JS and the golden fixtures would only agree on pure ASCII.
 */
size_t utf16Length(const std::string& s) {
  size_t n = 0;
  for (size_t i = 0; i < s.size();) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    size_t adv = 1;
    if (c >= 0xF0) adv = 4;
    else if (c >= 0xE0) adv = 3;
    else if (c >= 0xC0) adv = 2;
    n += (adv == 4) ? 2 : 1;  // astral codepoints are a surrogate PAIR in UTF-16
    i += adv;
  }
  return n;
}

/**
 * The byte prefix holding the first [units] UTF-16 code units.
 *
 * One deliberate departure from JS: `slice` can cut a surrogate pair in half, leaving a lone
 * surrogate. UTF-8 cannot represent that, so an astral character straddling the boundary is
 * dropped whole. It is a 160th-character emoji; the alternative is invalid output.
 */
std::string clipUtf16(const std::string& s, size_t units) {
  size_t n = 0;
  for (size_t i = 0; i < s.size();) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    size_t adv = 1;
    if (c >= 0xF0) adv = 4;
    else if (c >= 0xE0) adv = 3;
    else if (c >= 0xC0) adv = 2;
    const size_t next = n + ((adv == 4) ? 2 : 1);
    if (next > units) return s.substr(0, i);
    n = next;
    i += adv;
  }
  return s;
}

/** JS: t.replace(/\s+/g,' ').trim(), clip on a word boundary, then strip trailing [.;,]+ */
std::string leadItem(const std::string& text) {
  std::string t = collapseWhitespace(text);  // == replace(/\s+/g,' ').trim() for ASCII whitespace
  if (utf16Length(t) > LEAD_ITEM_CHARS) {
    t = clipUtf16(t, LEAD_ITEM_CHARS);
    // JS: replace(/\s+\S*$/, '') — drop the trailing partial word AND the space run before it.
    // The regex needs at least one space, so a 160-character run with none in it is left alone.
    size_t end = t.size();
    while (end > 0 && !std::isspace(static_cast<unsigned char>(t[end - 1]))) --end;
    if (end > 0) {
      while (end > 0 && std::isspace(static_cast<unsigned char>(t[end - 1]))) --end;
      t.resize(end);
    }
    t += "\xE2\x80\xA6";  // …
  }
  size_t b = t.size();
  while (b > 0 && (t[b - 1] == '.' || t[b - 1] == ';' || t[b - 1] == ',')) --b;
  t.resize(b);
  return t;
}

std::string joinLead(const std::vector<std::string>& items) {
  std::string out;
  for (size_t i = 0; i < items.size(); ++i) {
    if (i) out += "; ";
    out += leadItem(items[i]);
  }
  return out;
}

}  // namespace

/**
 * The overview line at the top of the rule-based minutes.
 *
 * It used to be the tally alone — "12 action items, 3 decisions, 5 open questions." Every word of
 * that is true and none of it says what the meeting was, which made an exported document read
 * like a receipt for work the app had done rather than a record of what was agreed. So it now
 * leads with what was decided and who owes what, and keeps the tally as the closing sentence so
 * nothing that used to be there is lost. Actions with a named owner are quoted ahead of unowned
 * ones because "Priya will send the report by Friday" is worth more to a reader than an
 * obligation nobody has taken.
 *
 * A meeting with neither decisions nor actions composes to exactly the old tally sentence, which
 * is the honest thing to say about it.
 *
 * Word-for-word identical to composeSummary() in src/pipeline/minutes.ts, and held there by the
 * shared fixtures in cpp/tests/golden.
 */
std::string composeSummary(const std::vector<std::string>& decisions,
                           const std::vector<std::string>& actions,
                           const std::vector<std::string>& questions) {
  const std::string tally =
      std::to_string(actions.size()) + " action item" + (actions.size() == 1 ? "" : "s") + ", " +
      std::to_string(decisions.size()) + " decision" + (decisions.size() == 1 ? "" : "s") + ", " +
      std::to_string(questions.size()) + " open question" + (questions.size() == 1 ? "" : "s") +
      ".";

  std::vector<std::string> sentences;
  if (!decisions.empty()) {
    std::vector<std::string> lead(decisions.begin(),
                                  decisions.begin() + std::min(LEAD_DECISIONS, decisions.size()));
    sentences.push_back("Decided: " + joinLead(lead) + ".");
  }
  if (!actions.empty()) {
    std::vector<std::string> ordered;
    ordered.reserve(actions.size());
    for (const auto& a : actions)
      if (a.find(UNASSIGNED) == std::string::npos) ordered.push_back(a);
    for (const auto& a : actions)
      if (a.find(UNASSIGNED) != std::string::npos) ordered.push_back(a);
    ordered.resize(std::min(LEAD_ACTIONS, ordered.size()));
    sentences.push_back("Next: " + joinLead(ordered) + ".");
  }
  sentences.push_back(tally);

  std::string out;
  for (size_t i = 0; i < sentences.size(); ++i) {
    if (i) out += " ";
    out += sentences[i];
  }
  return out;
}

std::vector<DraftMinute> extractMinutes(const std::vector<MinuteUtt>& utterances,
                                        const std::vector<MinuteSpk>& speakers) {
  std::unordered_map<std::string, std::string> name_by_id;
  for (const auto& s : speakers) name_by_id[s.id] = s.display_name;

  std::vector<DraftMinute> actions, decisions, questions;
  std::unordered_set<std::string> seen;

  auto add = [&seen](std::vector<DraftMinute>& arr, const std::string& kind,
                     const std::string& content) {
    const std::string key = kind + "|" + rules::norm(content);
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

    for (const auto& sentence : rules::splitSentences(rules::normalizeApostrophes(u.text))) {
      if (sentence.size() < 4) continue;

      if (rules::isQuestion(sentence)) {
        add(questions, "question", sentence);
        continue;  // a question is not also an action
      }
      if (rules::isDecision(sentence)) {
        add(decisions, "decision", sentence);
        continue;
      }
      if (rules::isAction(sentence)) {
        const std::string owner = rules::detectOwner(sentence, speaker_name);
        std::string due;
        std::string content = sentence + " \xE2\x80\x94 " + owner;  // " — <owner>"
        if (rules::matchDue(sentence, &due)) content += " (due " + due + ")";
        add(actions, "action", content);
      }
    }
  }

  if (actions.size() > 30) actions.resize(30);
  if (decisions.size() > 20) decisions.resize(20);
  if (questions.size() > 20) questions.resize(20);

  auto contents = [](const std::vector<DraftMinute>& v) {
    std::vector<std::string> out;
    out.reserve(v.size());
    for (const auto& d : v) out.push_back(d.content);
    return out;
  };
  DraftMinute summary{
      "summary",
      composeSummary(contents(decisions), contents(actions), contents(questions)),
      "rule"};

  std::vector<DraftMinute> out;
  out.push_back(summary);
  out.insert(out.end(), decisions.begin(), decisions.end());
  out.insert(out.end(), actions.begin(), actions.end());
  out.insert(out.end(), questions.begin(), questions.end());
  return out;
}

}  // namespace audionotes
