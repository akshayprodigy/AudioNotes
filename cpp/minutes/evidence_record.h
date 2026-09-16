// The typed record for one item: what the classifier is asked, the grammar that bounds its
// answer, and the validator that keeps it honest. The model can only quote — see validateRecord.
//
// Phase B of the evidence spine (docs/superpowers/specs/2026-09-16-evidence-record-and-review-
// design.md). The rules find the items; this reads the reply turns the rules cannot see and says
// what kind of statement each item was, whether a later turn pushed back on it, who owns it and
// when it was said to be due — as quoted spans, never as prose.
#pragma once
#include <string>
#include <vector>

namespace audionotes {

struct ClassifyTurn {
  int ordinal;          // 0 = the turn the item was lifted from
  std::string speaker;  // display name
  std::string text;
};

struct ItemRecord {
  std::string type = "uncertain";         // proposal|agreement|commitment|request|rejection|unresolved|uncertain
  std::string status = "open";            // open|qualified|contradicted|withdrawn
  std::string owner_kind = "unassigned";  // speaker|person|unassigned
  std::string owner_name;                 // a quoted span, for person
  std::string date_said;                  // a quoted span, or empty
  std::vector<int> cited;                 // turn ordinals within the window
  std::string confidence = "low";         // high|low
};

// The prompt: the window fenced as recorded speech, numbered "[n] Speaker: text", then the
// question. Transcript text enters through fenceTranscript and nowhere else.
std::string classifyPrompt(const std::string& item_text, const std::vector<ClassifyTurn>& window);

// GBNF for llama_sampler_init_grammar: the JSON object and only that.
extern const char* const kClassifyGrammar;

// Reads the grammar's exact shape. False for anything else — an empty string, a missing key, a
// value outside its enum. Deliberately not a JSON parser: nlohmann is kept off Android, and the
// grammar forbids quotes and backslashes inside strings, so there is nothing to unescape.
bool parseRecord(const std::string& json, ItemRecord* out);

// The same shape back, for the JNI seam. Quotes and backslashes in the two free strings cannot
// occur (the grammar forbids them); if they ever did they are dropped rather than escaped.
std::string toJson(const ItemRecord& r);

// Only verbatim survives: owner_name and date_said must appear (case-insensitive, whitespace
// folded) in a cited turn or they are blanked and confidence drops to low; a record that does not
// cite turn 0 becomes uncertain/low; a status other than open needs a cited turn other than 0.
ItemRecord validateRecord(const ItemRecord& r, const std::vector<ClassifyTurn>& window);

}  // namespace audionotes
