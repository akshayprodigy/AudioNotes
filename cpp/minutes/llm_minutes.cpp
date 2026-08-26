// The JSON half of the LLM minutes path: parsing the model's reply, and the map/reduce that
// produces it. Parity port of src/pipeline/summarize.ts; see summarize.ts for the reasoning on the
// placeholder filter (small models echo the template shape back).
//
// The prompt builders, transcript chunking and foldPlan live in llm_prompts.cpp, which needs no
// JSON parser — that split is what lets Android link the prompts without pulling nlohmann into
// libaudionotes (see the note in jni/audionotes_jni.cpp about its ~200 KB of template machinery).
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

  // One chunk means the map phase never ran, so what we hold is dialogue, not notes. It used to go
  // straight into reducePrompt, whose first words are "These are notes from consecutive parts of
  // ONE meeting" — a description of raw transcript that is simply false. Map it first, whatever
  // the chunk count.
  std::string notes;
  for (size_t i = 0; i < chunks.size(); ++i) {
    if (i) notes += "\n\n";
    notes += generate(mapPrompt(chunks[i]), 512);
  }
  return parseMinutesJson(generate(reducePrompt(notes), 768));
}

}  // namespace audionotes
