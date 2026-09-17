#include "minutes/evidence_record.h"

#include <algorithm>
#include <cctype>
#include <initializer_list>

#include "minutes/fence.h"

namespace audionotes {

// One object, every value an enum or a short quoted span, the cited turns a list of digits. The
// model cannot emit a heading, a sentence of commentary or a second object: the sampler masks
// every token the grammar does not admit. `str` forbids quotes and backslashes so the parser
// below needs no escape handling, and caps the span at 60 characters so a runaway quote of the
// whole turn is not an option either.
const char* const kClassifyGrammar = R"GBNF(
root ::= "{" ws "\"type\":" ws type "," ws "\"status\":" ws status "," ws "\"owner\":" ws owner "," ws "\"date_said\":" ws str "," ws "\"cited\":" ws cited "," ws "\"confidence\":" ws conf ws "}"
type ::= "\"proposal\"" | "\"agreement\"" | "\"commitment\"" | "\"request\"" | "\"rejection\"" | "\"unresolved\"" | "\"uncertain\""
status ::= "\"open\"" | "\"qualified\"" | "\"contradicted\"" | "\"withdrawn\""
owner ::= "{" ws "\"kind\":" ws okind "," ws "\"name\":" ws str ws "}"
okind ::= "\"speaker\"" | "\"person\"" | "\"unassigned\""
cited ::= "[" ws (num (ws "," ws num)*)? ws "]"
num ::= [0-9]
conf ::= "\"high\"" | "\"low\""
str ::= "\"" [^"\\]{0,60} "\""
ws ::= [ \t\n]*
)GBNF";

std::string classifyPrompt(const std::string& item_text, const std::vector<ClassifyTurn>& window) {
  std::string turns;
  for (const auto& t : window) {
    turns += "[" + std::to_string(t.ordinal) + "] " + t.speaker + ": " + t.text + "\n";
  }
  // Worked examples, on purpose and on other subjects. Measured 17 Sep on the Mac and the Pixel
  // with the same Qwen 1.5B: without any, the model answered every statement of the lead-example
  // meeting with the identical record — type "proposal" (the transcript's topic word, not the
  // statement's kind), date_said "[0]" (a turn number where a phrase belongs, which the
  // validator then blanks and marks low) — so six different statements made six identical
  // review cards. With ONE example it copied that example's type and status onto everything.
  // Four short ones, one per shape, are what stop a small model pattern-matching the example
  // instead of reading the statement. The grammar only ever told it the shape of the answer;
  // these tell it what each field means.
  return "Below are a few consecutive turns of a meeting, numbered. Turn [0] contains a statement "
         "that was picked out as a possible decision, task or question. Classify the STATEMENT.\n\n"
         "Fields:\n"
         "- type: what KIND of statement it is — commitment (the speaker says they will do it), "
         "request (someone asks another to do it), proposal (a suggestion not yet agreed), agreement "
         "(the group settled it), rejection (it was turned down), unresolved (a question left open), "
         "or uncertain if you cannot tell. The topic under discussion is not the type.\n"
         "- status: open, unless a LATER turn qualified it (added a condition or changed it), "
         "contradicted it (said no), or withdrew it (the speaker took it back).\n"
         "- owner: kind speaker if the speaker of [0] is the one doing it; kind person with the "
         "exact name as written if a named person is; unassigned otherwise.\n"
         "- date_said: the date or time WORDS in the statement, copied exactly, or empty. Never a "
         "turn number.\n"
         "- cited: the turn numbers you relied on; always include 0.\n"
         "- confidence: high or low.\n\n"
         "Examples.\n"
         "[0] Dev: Sam, can you send the report by Friday?\n"
         "[1] Sam: No, Friday is impossible, the data only comes in on Monday.\n"
         "Statement: Sam, can you send the report by Friday?\n"
         "Answer: {\"type\":\"request\",\"status\":\"contradicted\",\"owner\":{\"kind\":\"person\","
         "\"name\":\"Sam\"},\"date_said\":\"by Friday\",\"cited\":[0,1],\"confidence\":\"high\"}\n"
         "[0] Lina: I'll book the room tomorrow.\n"
         "[1] Omar: Thanks.\n"
         "Statement: I'll book the room tomorrow.\n"
         "Answer: {\"type\":\"commitment\",\"status\":\"open\",\"owner\":{\"kind\":\"speaker\","
         "\"name\":\"\"},\"date_said\":\"tomorrow\",\"cited\":[0],\"confidence\":\"high\"}\n"
         "[0] Ravi: So we're agreed, the price stays at forty.\n"
         "[1] Lina: Agreed.\n"
         "Statement: So we're agreed, the price stays at forty.\n"
         "Answer: {\"type\":\"agreement\",\"status\":\"open\",\"owner\":{\"kind\":\"unassigned\","
         "\"name\":\"\"},\"date_said\":\"\",\"cited\":[0,1],\"confidence\":\"high\"}\n"
         "[0] Omar: Where do we host the launch?\n"
         "[1] Ravi: Let's come back to that.\n"
         "Statement: Where do we host the launch?\n"
         "Answer: {\"type\":\"unresolved\",\"status\":\"open\",\"owner\":{\"kind\":\"unassigned\","
         "\"name\":\"\"},\"date_said\":\"\",\"cited\":[0,1],\"confidence\":\"high\"}\n\n"
         "Now the real one.\n"
         "TRANSCRIPT:\n" + fenceTranscript(turns) + "\n"
         "STATEMENT:\n" + fenceTranscript(item_text) + "\n"
         "Answer with one JSON object and nothing else.\n";
}

namespace {

std::string fold(const std::string& s) {
  std::string out;
  bool space = false;
  for (unsigned char c : s) {
    if (std::isspace(c)) {
      if (!space && !out.empty()) out += ' ';
      space = true;
    } else {
      out += static_cast<char>(std::tolower(c));
      space = false;
    }
  }
  while (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}

// The quoted value after `"key":`, searching from `from`. Sets *end to just past the closing quote.
bool quotedAfter(const std::string& s, const std::string& key, size_t from, std::string* out,
                 size_t* end) {
  const size_t k = s.find("\"" + key + "\"", from);
  if (k == std::string::npos) return false;
  const size_t colon = s.find(':', k);
  if (colon == std::string::npos) return false;
  const size_t q = s.find('"', colon + 1);
  if (q == std::string::npos) return false;
  const size_t e = s.find('"', q + 1);
  if (e == std::string::npos) return false;
  *out = s.substr(q + 1, e - q - 1);
  *end = e + 1;
  return true;
}

bool oneOf(const std::string& v, std::initializer_list<const char*> allowed) {
  for (const char* a : allowed) {
    if (v == a) return true;
  }
  return false;
}

std::string clean(const std::string& s) {
  std::string out;
  for (char c : s) {
    if (c != '"' && c != '\\') out += c;
  }
  return out;
}

}  // namespace

bool parseRecord(const std::string& json, ItemRecord* out) {
  if (json.empty() || !out) return false;
  ItemRecord r;
  size_t end = 0;
  if (!quotedAfter(json, "type", 0, &r.type, &end)) return false;
  if (!oneOf(r.type, {"proposal", "agreement", "commitment", "request", "rejection", "unresolved", "uncertain"})) return false;
  if (!quotedAfter(json, "status", end, &r.status, &end)) return false;
  if (!oneOf(r.status, {"open", "qualified", "contradicted", "withdrawn"})) return false;
  if (!quotedAfter(json, "kind", end, &r.owner_kind, &end)) return false;
  if (!oneOf(r.owner_kind, {"speaker", "person", "unassigned"})) return false;
  if (!quotedAfter(json, "name", end, &r.owner_name, &end)) return false;
  if (!quotedAfter(json, "date_said", end, &r.date_said, &end)) return false;
  const size_t c = json.find("\"cited\"", end);
  if (c == std::string::npos) return false;
  const size_t lb = json.find('[', c);
  const size_t rb = json.find(']', c);
  if (lb == std::string::npos || rb == std::string::npos || rb < lb) return false;
  for (size_t i = lb + 1; i < rb; ++i) {
    if (std::isdigit(static_cast<unsigned char>(json[i]))) r.cited.push_back(json[i] - '0');
  }
  if (!quotedAfter(json, "confidence", rb, &r.confidence, &end)) return false;
  if (!oneOf(r.confidence, {"high", "low"})) return false;
  *out = r;
  return true;
}

std::string toJson(const ItemRecord& r) {
  std::string cited;
  for (size_t i = 0; i < r.cited.size(); ++i) {
    if (i) cited += ",";
    cited += std::to_string(r.cited[i]);
  }
  return "{\"type\":\"" + r.type + "\",\"status\":\"" + r.status + "\",\"owner\":{\"kind\":\"" +
         r.owner_kind + "\",\"name\":\"" + clean(r.owner_name) + "\"},\"date_said\":\"" +
         clean(r.date_said) + "\",\"cited\":[" + cited + "],\"confidence\":\"" + r.confidence + "\"}";
}

ItemRecord validateRecord(const ItemRecord& in, const std::vector<ClassifyTurn>& window) {
  ItemRecord r = in;
  auto cites = [&](int ordinal) {
    return std::find(r.cited.begin(), r.cited.end(), ordinal) != r.cited.end();
  };
  auto verbatim = [&](const std::string& span) {
    if (span.empty()) return false;
    const std::string f = fold(span);
    for (const auto& t : window) {
      if (!cites(t.ordinal)) continue;
      if (fold(t.text).find(f) != std::string::npos) return true;
    }
    return false;
  };
  // A reading that does not cite the turn the item came from is not a reading of that item.
  if (!cites(0)) {
    r.type = "uncertain";
    r.confidence = "low";
  }
  // Only a name that is actually in the cited text is a name; anything else was invented.
  if (r.owner_kind == "person" && !verbatim(r.owner_name)) {
    r.owner_kind = "unassigned";
    r.owner_name.clear();
    r.confidence = "low";
  }
  if (r.owner_kind != "person") r.owner_name.clear();
  if (!r.date_said.empty() && !verbatim(r.date_said)) {
    r.date_said.clear();
    r.confidence = "low";
  }
  // "Contradicted" by whom? A status other than open needs a reply turn behind it.
  if (r.status != "open") {
    bool second = false;
    for (int o : r.cited) {
      if (o != 0) second = true;
    }
    if (!second) r.status = "open";
  }
  return r;
}

}  // namespace audionotes
