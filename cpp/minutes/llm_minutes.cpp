// Parity port of src/pipeline/summarize.ts. The prompt strings are copied VERBATIM from the TS —
// they are model-tuned artifacts, not prose to be improved. See summarize.ts for the reasoning
// on the placeholder filter (small models echo the template shape back).
#include "minutes/llm_minutes.h"

#include <cctype>
#include <regex>
#include <unordered_map>

#include "nlohmann/json.hpp"

namespace audionotes {
namespace {

using nlohmann::json;

// JS: !/[a-z0-9]/i.test(text.replace(/<[^>]*>/g, ''))
bool isPlaceholder(const std::string& text) {
  static const std::regex ANGLE(R"rx(<[^>]*>)rx");
  static const std::regex ALNUM(R"rx([a-z0-9])rx", std::regex::icase);
  return !std::regex_search(std::regex_replace(text, ANGLE, ""), ALNUM);
}

std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
  while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
  return s.substr(a, b - a);
}

// Tolerant string read: JSON strings pass through, everything else -> "".
std::string asString(const json& v) {
  if (v.is_string()) return v.get<std::string>();
  return "";
}

}  // namespace

std::vector<std::string> transcriptLines(const std::vector<MinuteUtt>& utterances,
                                         const std::vector<MinuteSpk>& speakers) {
  std::unordered_map<std::string, std::string> name_by_id;
  for (const auto& s : speakers) name_by_id[s.id] = s.display_name;
  std::vector<std::string> out;
  out.reserve(utterances.size());
  for (const auto& u : utterances) {
    std::string who = "Speaker";
    if (!u.speaker_id.empty()) {
      auto it = name_by_id.find(u.speaker_id);
      if (it != name_by_id.end()) who = it->second;
    }
    out.push_back(who + ": " + u.text);
  }
  return out;
}

std::vector<std::string> chunkTranscript(const std::vector<std::string>& lines,
                                         size_t max_chars) {
  std::vector<std::string> chunks;
  std::string cur;
  for (const auto& line : lines) {
    if (cur.size() + line.size() + 1 > max_chars && !cur.empty()) {
      chunks.push_back(cur);
      cur.clear();
    }
    cur += (cur.empty() ? "" : "\n") + line;
  }
  if (!cur.empty()) chunks.push_back(cur);
  return chunks;
}

std::string mapPrompt(const std::string& chunk) {
  return "Below is part of a meeting transcript. Extract only what is explicitly stated. "
         "List decisions, action items (with owner and any due date), and open questions. "
         "Be concise and factual; do not invent anything.\n\n"
         "TRANSCRIPT:\n" + chunk + "\n\n"
         "Format:\nDECISIONS:\n- ...\nACTIONS:\n- <task> \xE2\x80\x94 <owner> (due <when>)\nQUESTIONS:\n- ...";
}

std::string reducePrompt(const std::string& notes) {
  return "These are notes from consecutive parts of ONE meeting. Merge them into final minutes. "
         "Remove duplicates. Only include what the notes support.\n\n"
         "NOTES:\n" + notes + "\n\n"
         "Respond with ONLY a JSON object, no prose, in exactly this shape. Replace every "
         "angle-bracket description with real text from the notes, and use an empty array when a "
         "section has nothing in it:\n"
         "{\"summary\":\"<2-3 sentence overview>\",\"decisions\":[\"<a decision that was made>\"],"
         "\"actions\":[{\"text\":\"<what will be done>\",\"owner\":\"<who>\",\"due\":\"<when, or empty>\"}],"
         "\"questions\":[\"<a question left unanswered>\"]}";
}

std::string narrativePrompt(const std::string& notes) {
  return "Below is the record of one meeting. Write the minutes as plain prose for someone who was "
         "not there.\n\n"
         "RECORD:\n" + notes + "\n\n"
         "Write three or four short paragraphs: what the meeting was about, what the group worked "
         "through, what was settled, and what was left open. Use only what the record supports. "
         "Do not use headings, bullet points, or numbered lists. Do not comment on what the record "
         "does or does not contain. Start writing the minutes now:";
}

std::string summaryPrompt(const std::string& narrative) {
  return "Below are the minutes of a meeting.\n\n"
         "MINUTES:\n" + narrative + "\n\n"
         "Write 2 to 3 sentences saying what the meeting was about and where it ended up. Write "
         "plain prose. Do not list items, do not use headings, and do not comment on what the "
         "minutes do or do not contain. Start writing the summary now:";
}

std::string headlinePrompt(const std::string& summary) {
  return "Below is a summary of a meeting.\n\n"
         "SUMMARY:\n" + summary + "\n\n"
         "In ONE sentence of at most 15 words, say what this meeting was about. Write only that "
         "sentence, with no label, no quotation marks and no trailing notes:";
}

std::optional<std::vector<DraftMinute>> parseMinutesJson(const std::string& raw) {
  const size_t start = raw.find('{');
  const size_t end = raw.rfind('}');
  if (start == std::string::npos || end == std::string::npos || end <= start) return std::nullopt;

  json obj = json::parse(raw.substr(start, end - start + 1), nullptr, /*allow_exceptions=*/false);
  if (obj.is_discarded() || !obj.is_object()) return std::nullopt;

  std::vector<DraftMinute> out;
  auto push = [&out](const std::string& kind, const std::string& content) {
    const std::string c = trim(content);
    if (!c.empty() && !isPlaceholder(c)) out.push_back({kind, c, "llm"});
  };

  if (obj.contains("summary")) push("summary", asString(obj["summary"]));
  if (obj.contains("decisions") && obj["decisions"].is_array())
    for (const auto& d : obj["decisions"])
      push("decision", d.is_string() ? d.get<std::string>()
                                     : (d.is_object() && d.contains("text") ? asString(d["text"]) : ""));
  if (obj.contains("actions") && obj["actions"].is_array()) {
    for (const auto& a : obj["actions"]) {
      if (a.is_string()) {
        push("action", a.get<std::string>());
      } else if (a.is_object()) {
        // Judge each field BEFORE composing (see summarize.ts isPlaceholder note): the em dash
        // and the literal word "due" we add are letters the filter would count as content.
        const std::string text = trim(a.contains("text") ? asString(a["text"]) : "");
        if (text.empty() || isPlaceholder(text)) continue;
        std::string s = text;
        const std::string owner = trim(a.contains("owner") ? asString(a["owner"]) : "");
        if (!owner.empty() && !isPlaceholder(owner)) s += " \xE2\x80\x94 " + owner;
        const std::string due = trim(a.contains("due") ? asString(a["due"]) : "");
        static const std::regex NA(R"rx(^n/?a$)rx", std::regex::icase);
        if (!due.empty() && !isPlaceholder(due) && !std::regex_match(due, NA)) s += " (due " + due + ")";
        push("action", s);
      }
    }
  }
  if (obj.contains("questions") && obj["questions"].is_array())
    for (const auto& q : obj["questions"])
      push("question", q.is_string() ? q.get<std::string>()
                                     : (q.is_object() && q.contains("text") ? asString(q["text"]) : ""));

  if (out.empty()) return std::nullopt;
  return out;
}

std::optional<std::vector<DraftMinute>> enhanceMinutes(const std::vector<MinuteUtt>& utterances,
                                                       const std::vector<MinuteSpk>& speakers,
                                                       const GenerateFn& generate) {
  if (utterances.empty()) return std::nullopt;
  const auto lines = transcriptLines(utterances, speakers);
  const auto chunks = chunkTranscript(lines);

  std::string notes;
  if (chunks.size() == 1) {
    notes = chunks[0];
  } else {
    for (size_t i = 0; i < chunks.size(); ++i) {
      if (i) notes += "\n\n";
      notes += generate(mapPrompt(chunks[i]), 512);
    }
  }
  return parseMinutesJson(generate(reducePrompt(notes), 768));
}

}  // namespace audionotes
