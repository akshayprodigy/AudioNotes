# Evidence Record and Review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pro items carry a typed record (type, status, owner, date) read by a grammar-constrained classifier that sees the reply turns; the items it could not settle go to a per-meeting card flow where a person confirms, fixes or rejects them; all of it survives a reprocess.

**Architecture:** C++ core: `evidence_record` (prompt builder over a fenced reply window, a GBNF grammar, a hand-rolled parser for the grammar's fixed shape, a validator that only admits verbatim spans) and `LlamaEngine::generateConstrained`. Kotlin: `ItemClassifier` runs inside the narrate stage and writes the five reserved `items` columns via `AudioDb.classifyItem`; `DateNorm` and `ReviewRule` are pure, mirrored in TypeScript against shared golden JSON; `StoredItem`/`Reconciler.Row`/`replaceItems` carry the record through a reprocess. JS: `db.items` exposes the record and hides rejected rows; a Summary banner counts `needs_review` classified items; `ReviewScreen` is the card flow.

**Tech Stack:** C++17 + llama.cpp grammar sampler (no nlohmann on Android — hand parser), Kotlin + JUnit, TypeScript/React Native + jest, SQLCipher (no schema change), the existing fence and fencing scan.

Spec: `docs/superpowers/specs/2026-09-16-evidence-record-and-review-design.md`.

**House rule:** every new test is mutation-checked; never run a mutation-restore in the background. Goldens shared across languages live in `cpp/tests/golden/` (jest reads them by relative path, JUnit via the `golden` resource dir — see Task 3 for the wiring).

---

## File map

| File | Responsibility |
|---|---|
| `cpp/minutes/evidence_record.{h,cpp}` (new) | `ClassifyTurn`, `ItemRecord`; `classifyPrompt()` (fenced), `kClassifyGrammar`, `parseRecord()`, `validateRecord()`. |
| `cpp/tests/test_evidence_record.cpp` (new) | Parser/validator tests incl. the lead example. |
| `cpp/llm/llama_engine.{h,cpp}` | `generateConstrained(prompt, max_tokens, grammar)`. |
| `cpp/jni/audionotes_jni.cpp` | `nativeLlmGenerateConstrained`, `nativeClassifyPrompt`, `nativeClassifyGrammar`, `nativeValidateRecord`. |
| `android/.../pipeline/NativeBridge.kt` | The four externals. |
| `cpp/tests/golden/date_norm.json`, `review_rule.json` (new) | Shared tables. |
| `android/.../pipeline/DateNorm.kt`, `ReviewRule.kt` (new) + tests | Pure rules. |
| `src/pipeline/dateNorm.ts`, `reviewRule.ts` (new) + tests | Mirrors. |
| `android/.../data/AudioDb.kt` | `Classified`, `StoredItem.record`, `classifyItem`, `setItemReview/Owner/Date/Type`, `replaceItems` carries the record. |
| `android/.../pipeline/Reconciler.kt` + test | `Row.record` carried on match and on preservation. |
| `android/.../pipeline/ItemClassifier.kt` (new) | Window → prompt → constrained generate → validate → owner/date/review → write. |
| `android/.../pipeline/Narrator.kt` | Runs the classifier before the prose. |
| `src/pipeline/types.ts`, `src/db/queries.ts` | `Item` record fields; rejected hidden; the four setters. |
| `src/screens/meeting/SummaryTab.tsx` | The banner. |
| `src/screens/ReviewScreen.tsx` (new) + `RootNavigator.tsx` | The card flow. |
| `src/screens/meeting/shared.tsx` | Label chips for a typed item. |
| `android/.../pipeline/FileExportModule.kt`, `AudioDb.indexItems` | Rejected rows excluded. |

---

## Part B — the record

### Task 1: `evidence_record` — prompt, grammar, parser, validator (C++)

**Files:**
- Create: `cpp/minutes/evidence_record.h`, `cpp/minutes/evidence_record.cpp`
- Create: `cpp/tests/test_evidence_record.cpp`
- Modify: `cpp/cli/CMakeLists.txt` (register the test; add `evidence_record.cpp` to the library sources next to `evidence.cpp`)
- Modify: `cpp/CMakeLists.txt` if the core library lists sources explicitly (grep `evidence.cpp`)

- [ ] **Step 1: Failing test** — `cpp/tests/test_evidence_record.cpp`

```cpp
// The typed record: what the classifier may say, and what the validator lets through.
// The model can only quote. A name or a date it did not find verbatim in a cited turn is blanked
// and the record marked low-confidence; a status it cannot back with a second turn falls to open.
#include "minutes/evidence_record.h"
#include <cassert>
#include <cstdio>
#include <string>
#include <vector>

using namespace audionotes;

static std::vector<ClassifyTurn> leadExample() {
  return {
      {0, "Priya", "Can you send the proposal Friday?"},
      {1, "Rahul", "Only a draft; the final version needs another week."},
      {2, "Priya", "Fine, a draft then."},
  };
}

static void promptIsFencedAndNumbered() {
  const std::string p = classifyPrompt("Can you send the proposal Friday?", leadExample());
  assert(p.find("[0] Priya: Can you send the proposal Friday?") != std::string::npos);
  assert(p.find("[1] Rahul: Only a draft") != std::string::npos);
  // The transcript goes in through the fence: the fence's private-use delimiter is present.
  assert(p.find("\xEE\x80\x80") != std::string::npos || p.find("TRANSCRIPT") != std::string::npos);
}

static void parserReadsTheGrammarsShape() {
  ItemRecord r;
  const bool ok = parseRecord(
      R"({"type":"request","status":"contradicted","owner":{"kind":"person","name":"Rahul"},)"
      R"("date_said":"Friday","cited":[0,1],"confidence":"high"})", &r);
  assert(ok);
  assert(r.type == "request");
  assert(r.status == "contradicted");
  assert(r.owner_kind == "person" && r.owner_name == "Rahul");
  assert(r.date_said == "Friday");
  assert(r.cited.size() == 2 && r.cited[0] == 0 && r.cited[1] == 1);
  assert(r.confidence == "high");
}

static void parserRejectsWhatTheGrammarWouldNever() {
  ItemRecord r;
  assert(!parseRecord("", &r));
  assert(!parseRecord(R"({"type":"request"})", &r));
  assert(!parseRecord(R"({"type":"fancy","status":"open","owner":{"kind":"unassigned","name":""},"date_said":"","cited":[0],"confidence":"high"})", &r));
}

static void validatorBlanksANonVerbatimName() {
  ItemRecord r;
  parseRecord(R"({"type":"commitment","status":"open","owner":{"kind":"person","name":"Priyanka"},"date_said":"Friday","cited":[0],"confidence":"high"})", &r);
  const ItemRecord v = validateRecord(r, leadExample());
  assert(v.owner_kind == "unassigned" && v.owner_name.empty());
  assert(v.confidence == "low");
  assert(v.date_said == "Friday");  // verbatim in turn 0, kept
}

static void validatorNeedsTheSourceCited() {
  ItemRecord r;
  parseRecord(R"({"type":"request","status":"open","owner":{"kind":"unassigned","name":""},"date_said":"","cited":[1],"confidence":"high"})", &r);
  const ItemRecord v = validateRecord(r, leadExample());
  assert(v.type == "uncertain");
  assert(v.confidence == "low");
}

static void validatorNeedsASecondTurnForAStatus() {
  ItemRecord r;
  parseRecord(R"({"type":"request","status":"contradicted","owner":{"kind":"unassigned","name":""},"date_said":"","cited":[0],"confidence":"high"})", &r);
  const ItemRecord v = validateRecord(r, leadExample());
  assert(v.status == "open");
}

static void theLeadExampleValidatesWhole() {
  ItemRecord r;
  parseRecord(R"({"type":"request","status":"contradicted","owner":{"kind":"speaker","name":""},"date_said":"Friday","cited":[0,1],"confidence":"high"})", &r);
  const ItemRecord v = validateRecord(r, leadExample());
  assert(v.type == "request" && v.status == "contradicted");
  assert(v.cited.size() == 2);
  assert(v.date_said == "Friday");
  assert(v.confidence == "high");
}

static void grammarNamesEveryEnumAndNothingElse() {
  const std::string g = kClassifyGrammar;
  for (const char* t : {"proposal", "agreement", "commitment", "request", "rejection", "unresolved", "uncertain",
                        "open", "qualified", "contradicted", "withdrawn", "speaker", "person", "unassigned", "high", "low"}) {
    assert(g.find(std::string("\"\\\"") + t + "\\\"\"") != std::string::npos);
  }
  assert(g.find("root ::=") != std::string::npos);
}

int main() {
  promptIsFencedAndNumbered();
  parserReadsTheGrammarsShape();
  parserRejectsWhatTheGrammarWouldNever();
  validatorBlanksANonVerbatimName();
  validatorNeedsTheSourceCited();
  validatorNeedsASecondTurnForAStatus();
  theLeadExampleValidatesWhole();
  grammarNamesEveryEnumAndNothingElse();
  std::puts("test_evidence_record: ok");
  return 0;
}
```

- [ ] **Step 2: Register and run — fails to compile.** In `cpp/cli/CMakeLists.txt` after `test_evidence`: `audionotes_add_test(test_evidence_record ${CORE}/tests/test_evidence_record.cpp ${CORE}/minutes/evidence_record.cpp ${CORE}/minutes/fence.cpp)`. Add `minutes/evidence_record.cpp` wherever `minutes/evidence.cpp` is listed for the library/CLI and for the Android JNI CMake (`android/app/src/main/cpp/CMakeLists.txt` — grep `evidence.cpp`).

- [ ] **Step 3: Implement.** `evidence_record.h`:

```cpp
// The typed record for one item: what the classifier is asked, the grammar that bounds its
// answer, and the validator that keeps it honest. The model can only quote — see validateRecord.
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
  std::string type = "uncertain";     // proposal|agreement|commitment|request|rejection|unresolved|uncertain
  std::string status = "open";        // open|qualified|contradicted|withdrawn
  std::string owner_kind = "unassigned";  // speaker|person|unassigned
  std::string owner_name;             // a quoted span, for person
  std::string date_said;              // a quoted span, or empty
  std::vector<int> cited;             // turn ordinals within the window
  std::string confidence = "low";     // high|low
};

// The prompt: the window fenced as recorded speech, numbered "[n] Speaker: text", then the
// question. Transcript text enters through fenceTranscript and nowhere else.
std::string classifyPrompt(const std::string& item_text, const std::vector<ClassifyTurn>& window);

// GBNF for llama_sampler_init_grammar: the JSON object and only that.
extern const char* const kClassifyGrammar;

// Reads the grammar's exact shape. False for anything else — an empty string, a missing key, a
// value outside its enum. Deliberately not a JSON parser: nlohmann is kept off Android.
bool parseRecord(const std::string& json, ItemRecord* out);

// Only verbatim survives: owner_name and date_said must appear (case-insensitive, whitespace
// folded) in a cited turn or they are blanked and confidence drops to low; a record that does not
// cite turn 0 becomes uncertain/low; a status other than open needs a cited turn other than 0.
ItemRecord validateRecord(const ItemRecord& r, const std::vector<ClassifyTurn>& window);

}  // namespace audionotes
```

`evidence_record.cpp`:

```cpp
#include "minutes/evidence_record.h"
#include "minutes/fence.h"
#include <algorithm>
#include <cctype>

namespace audionotes {

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
  return "Below are a few consecutive turns of a meeting, numbered. Turn [0] contains a statement "
         "that was picked out as a possible decision, task or question.\n\n"
         "TRANSCRIPT:\n" + fenceTranscript(turns) + "\n"
         "STATEMENT: " + fenceTranscript(item_text) + "\n\n"
         "Read the later turns for a reply that qualifies, contradicts or withdraws the statement.\n"
         "Answer with one JSON object and nothing else:\n"
         "- type: proposal, agreement, commitment, request, rejection, unresolved, or uncertain if you cannot tell.\n"
         "- status: open unless a later turn qualified, contradicted or withdrew it.\n"
         "- owner: kind speaker if the speaker of [0] is doing it; person with the exact name as written if a named person is; unassigned otherwise.\n"
         "- date_said: the date or time phrase exactly as written, or empty.\n"
         "- cited: the turn numbers you relied on; always include 0.\n"
         "- confidence: high or low.\n";
}

namespace {

std::string fold(const std::string& s) {
  std::string out;
  bool space = false;
  for (unsigned char c : s) {
    if (std::isspace(c)) { if (!space && !out.empty()) out += ' '; space = true; }
    else { out += static_cast<char>(std::tolower(c)); space = false; }
  }
  while (!out.empty() && out.back() == ' ') out.pop_back();
  return out;
}

// Value of `"key":` — a quoted string — starting the search at `from`. Empty when absent.
bool quotedAfter(const std::string& s, const std::string& key, size_t from, std::string* out, size_t* end) {
  size_t k = s.find("\"" + key + "\"", from);
  if (k == std::string::npos) return false;
  size_t q = s.find('"', s.find(':', k) + 1);
  if (q == std::string::npos) return false;
  size_t e = s.find('"', q + 1);
  if (e == std::string::npos) return false;
  *out = s.substr(q + 1, e - q - 1);
  *end = e + 1;
  return true;
}

bool oneOf(const std::string& v, std::initializer_list<const char*> allowed) {
  for (const char* a : allowed) if (v == a) return true;
  return false;
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
  size_t c = json.find("\"cited\"", end);
  if (c == std::string::npos) return false;
  size_t lb = json.find('[', c), rb = json.find(']', c);
  if (lb == std::string::npos || rb == std::string::npos || rb < lb) return false;
  for (size_t i = lb + 1; i < rb; ++i) {
    if (std::isdigit(static_cast<unsigned char>(json[i]))) r.cited.push_back(json[i] - '0');
  }
  if (!quotedAfter(json, "confidence", rb, &r.confidence, &end)) return false;
  if (!oneOf(r.confidence, {"high", "low"})) return false;
  *out = r;
  return true;
}

ItemRecord validateRecord(const ItemRecord& in, const std::vector<ClassifyTurn>& window) {
  ItemRecord r = in;
  auto cites = [&](int ordinal) { return std::find(r.cited.begin(), r.cited.end(), ordinal) != r.cited.end(); };
  auto verbatim = [&](const std::string& span) {
    if (span.empty()) return false;
    const std::string f = fold(span);
    for (const auto& t : window) {
      if (!cites(t.ordinal)) continue;
      if (fold(t.text).find(f) != std::string::npos) return true;
    }
    return false;
  };
  if (!cites(0)) {
    r.type = "uncertain";
    r.confidence = "low";
  }
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
  if (r.status != "open") {
    bool second = false;
    for (int o : r.cited) if (o != 0) second = true;
    if (!second) r.status = "open";
  }
  return r;
}

}  // namespace audionotes
```

- [ ] **Step 4: Build and run** — `CMAKE=$HOME/Library/Android/sdk/cmake/3.22.1/bin/cmake; $CMAKE --build cpp/cli/build -j 8 && (cd cpp/cli/build && ./test_evidence_record ../../tests/golden)` → `test_evidence_record: ok`; `ctest` all pass; `python3 scripts/check-prompt-fencing.py` passes (both operands fenced).

- [ ] **Step 5: Mutation-check** — remove the `!cites(0)` block: `validatorNeedsTheSourceCited` fails. Make `verbatim` return true: `validatorBlanksANonVerbatimName` fails. Restore.

- [ ] **Step 6: Commit** — `git commit -m "feat(record): evidence_record — the classifier's prompt, grammar, parser and validator"`

---

### Task 2: Constrained generation through the engine and JNI

**Files:**
- Modify: `cpp/llm/llama_engine.h` (+ `generateConstrained`), `cpp/llm/llama_engine.cpp`
- Modify: `cpp/jni/audionotes_jni.cpp`, `android/app/src/main/java/com/innocorelabs/verbale/pipeline/NativeBridge.kt`
- Test: device (`NativePipelineTest.classifier_grammar_constrains_the_answer`, Task 8)

- [ ] **Step 1: Engine.** Header: `std::string generateConstrained(const std::string& prompt, int max_tokens, const std::string& grammar);`. Impl: factor the decode loop of `generate` into `std::string run(const std::string& prompt, int max_tokens, llama_sampler* sampler)`; `generate` passes `smpl`; `generateConstrained` builds a temporary chain — `llama_sampler_chain_init`, add `llama_sampler_init_grammar(vocab, grammar.c_str(), "root")` (return "" and log if it returns null: the grammar failed to parse), add the same penalties + greedy as `load` did — runs, frees the chain. Grammar first in the chain, greedy after: the grammar masks, greedy picks.

- [ ] **Step 2: JNI.**
  - `nativeLlmGenerateConstrained(handle, prompt, maxTokens, grammar): String` — like `nativeLlmGenerate` with the extra string.
  - `nativeClassifyGrammar(): String` — returns `kClassifyGrammar`.
  - `nativeClassifyPrompt(itemText: String, ordinals: IntArray, speakers: Array<String>, texts: Array<String>): String` — builds the window and returns `classifyPrompt`.
  - `nativeValidateRecord(json: String, ordinals: IntArray, speakers: Array<String>, texts: Array<String>): String` — `parseRecord` (returns `""` when it fails) then `validateRecord`, serialised back as the same JSON shape (write a tiny `toJson(const ItemRecord&)` in `evidence_record.cpp`, escaping `"` and `\\` in the two strings).
  - `NativeBridge.kt` externals with KDoc.

- [ ] **Step 3: Build both** — `$CMAKE --build cpp/cli/build -j 8`; `npm run -s apk` → BUILD SUCCESSFUL.

- [ ] **Step 4: Commit** — `git commit -m "feat(record): constrained generation — the classifier's grammar reaches the sampler"`

---

### Task 3: `DateNorm` — pure, both languages, one golden

**Files:**
- Create: `cpp/tests/golden/date_norm.json`
- Create: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/DateNorm.kt`, `android/app/src/test/java/com/innocorelabs/verbale/pipeline/DateNormTest.kt`
- Create: `src/pipeline/dateNorm.ts`, `src/pipeline/__tests__/dateNorm.test.ts`

Golden (meeting date fixed: Wednesday 16 Sep 2026 15:00 IST = `1789551000000`; expected values are the local midnight of the resolved day, IST, or null):

```json
{
  "meetingAt": 1789551000000,
  "timeZone": "Asia/Kolkata",
  "cases": [
    { "said": "tomorrow", "norm": "2026-09-17" },
    { "said": "today", "norm": "2026-09-16" },
    { "said": "Friday", "norm": "2026-09-18" },
    { "said": "this Friday", "norm": "2026-09-18" },
    { "said": "by Friday", "norm": "2026-09-18" },
    { "said": "next Friday", "norm": "2026-09-25" },
    { "said": "Wednesday", "norm": "2026-09-23" },
    { "said": "end of the week", "norm": "2026-09-18" },
    { "said": "on the 21st", "norm": "2026-09-21" },
    { "said": "by the 3rd", "norm": "2026-10-03" },
    { "said": "in two weeks", "norm": "2026-09-30" },
    { "said": "next week", "norm": null },
    { "said": "another week", "norm": null },
    { "said": "soon", "norm": null },
    { "said": "after the launch", "norm": null },
    { "said": "", "norm": null }
  ]
}
```

Both implementations return the resolved day as `YYYY-MM-DD` in the given zone (the epoch stored in `date_norm` is that day's local midnight; the tests compare the day string so the two languages cannot disagree by a timezone). Rules, in order: `today` / `tomorrow`; `next <weekday>` = the second occurrence after the meeting day; `this <weekday>` / `<weekday>` (with optional `by`/`on`) = the first occurrence after the meeting day (same weekday → a week later); `end of the week` = Friday, first occurrence (or today if Friday); `the <n>(st|nd|rd|th)` = that day this month, or next month if it has passed; `in <n> weeks|days` (numbers one–ten and digits). Everything else → null. Whole-phrase, case-insensitive, punctuation stripped.

- [ ] **Step 1: Kotlin test** — reads the golden from `../cpp/tests/golden/date_norm.json` relative to the `android/` working directory (JUnit's cwd is `android/app`; use `File("../../cpp/tests/golden/date_norm.json")`, failing loudly if absent). One `@Test` iterating cases with `assertEquals(said, expected, DateNorm.resolveDay(said, meetingAt, zone))`; one `@Test` that `resolve("Friday", meetingAt, zone)` returns the epoch of 2026-09-18 00:00 IST.

- [ ] **Step 2: Implement `DateNorm.kt`** (`object DateNorm { fun resolveDay(said, meetingAtMs, zoneId): String?; fun resolve(said, meetingAtMs, zoneId): Long? }` using `java.time`).

- [ ] **Step 3: TS mirror** — `src/pipeline/dateNorm.ts` exporting `resolveDay(said, meetingAtMs, timeZone)` and `resolveDateNorm(...)`, arithmetic in UTC over the zone's local day (use `Intl.DateTimeFormat` with `timeZone` to read local Y/M/D/weekday, then build the day); test reads `../../../cpp/tests/golden/date_norm.json`.

- [ ] **Step 4: Both suites pass. Mutation-check** — make `next <weekday>` return the first occurrence: the golden fails in both. Restore.

- [ ] **Step 5: Commit** — `git commit -m "feat(record): DateNorm — a spoken date phrase to a day, or honestly null, in both languages"`

---

### Task 4: `ReviewRule` — pure, both languages, one golden

**Files:**
- Create: `cpp/tests/golden/review_rule.json`
- Create: `android/.../pipeline/ReviewRule.kt` + `ReviewRuleTest.kt`; `src/pipeline/reviewRule.ts` + test

Golden:

```json
{ "cases": [
  { "name": "clean commitment", "kind": "action", "type": "commitment", "status": "open", "confidence": "high", "ownerKind": "person", "dateSaid": "Friday", "dateNorm": 1, "review": "suggested", "expect": "suggested", "reason": null },
  { "name": "uncertain type", "kind": "action", "type": "uncertain", "status": "open", "confidence": "high", "ownerKind": "person", "dateSaid": "", "dateNorm": null, "review": "suggested", "expect": "needs_review", "reason": "type" },
  { "name": "low confidence", "kind": "decision", "type": "agreement", "status": "open", "confidence": "low", "ownerKind": "unassigned", "dateSaid": "", "dateNorm": null, "review": "suggested", "expect": "needs_review", "reason": "type" },
  { "name": "qualified later", "kind": "action", "type": "request", "status": "qualified", "confidence": "high", "ownerKind": "speaker", "dateSaid": "Friday", "dateNorm": 1, "review": "suggested", "expect": "needs_review", "reason": "status" },
  { "name": "action with no owner", "kind": "action", "type": "commitment", "status": "open", "confidence": "high", "ownerKind": "unassigned", "dateSaid": "", "dateNorm": null, "review": "suggested", "expect": "needs_review", "reason": "owner" },
  { "name": "decision with no owner is fine", "kind": "decision", "type": "agreement", "status": "open", "confidence": "high", "ownerKind": "unassigned", "dateSaid": "", "dateNorm": null, "review": "suggested", "expect": "suggested", "reason": null },
  { "name": "date said but not pinned", "kind": "action", "type": "commitment", "status": "open", "confidence": "high", "ownerKind": "person", "dateSaid": "next week", "dateNorm": null, "review": "suggested", "expect": "needs_review", "reason": "date" },
  { "name": "confirmed stays", "kind": "action", "type": "uncertain", "status": "contradicted", "confidence": "low", "ownerKind": "unassigned", "dateSaid": "soon", "dateNorm": null, "review": "confirmed", "expect": "confirmed", "reason": null },
  { "name": "rejected stays", "kind": "action", "type": "uncertain", "status": "open", "confidence": "low", "ownerKind": "unassigned", "dateSaid": "", "dateNorm": null, "review": "rejected", "expect": "rejected", "reason": null }
] }
```

Both: `decide(kind, type, status, confidence, ownerKind, dateSaid, dateNorm, currentReview) → { review, reason: 'type'|'status'|'owner'|'date'|null }`; reasons in that priority. Tests iterate the golden.

- [ ] **Step 1–4:** test (both) → implement (both) → pass → mutation-check (drop the owner rule: "action with no owner" fails in both) → restore.

- [ ] **Step 5: Commit** — `git commit -m "feat(record): ReviewRule — what the model could not settle, in both languages"`

---

### Task 5: The record in the database and through the Reconciler

**Files:**
- Modify: `android/.../data/AudioDb.kt` (`StoredItem`, `items()`, `replaceItems`, new `classifyItem`, `setItemReview`, `setItemOwner`, `setItemDate`, `setItemType`)
- Modify: `android/.../pipeline/Reconciler.kt` (`Row.record`), `ReconcilerTest.kt`
- Modify: `src/pipeline/types.ts` (`Item` fields), `src/db/queries.ts` (`items` selects them and hides rejected; the four setters)
- Check: `python3 scripts/mutate-reconciler.py` still applies every patch.

- [ ] **Step 1: Failing Kotlin test** (ReconcilerTest) — a confident match carries the record; an ambiguous one carries it and re-queues; a replaced row has none:

```kotlin
  private val classified = AudioDb.Classified("request", "contradicted", """{"kind":"person","name":"Rahul"}""", "Friday", null)

  @Test fun aConfidentMatchCarriesTheTypedRecord() {
    val old = stored("a", "Send the proposal Friday", 1000, 2000, review = "confirmed").copy(record = classified)
    val plan = Reconciler.reconcile(listOf(old), listOf(incoming("Send the proposal Friday", 1000, 2000)))
    assertEquals(classified, plan.rows.single().record)
    assertEquals("confirmed", plan.rows.single().review)
  }

  @Test fun anAmbiguousMatchCarriesTheRecordAndReQueues() {
    val old = stored("a", "Send the proposal on Friday", 1000, 2000, review = "confirmed").copy(record = classified)
    val plan = Reconciler.reconcile(listOf(old), listOf(incoming("Do not send the proposal on Friday", 1000, 2000)))
    assertEquals(classified, plan.rows.single().record)
    assertEquals("needs_review", plan.rows.single().review)
  }

  @Test fun aFreshRowHasNoRecord() {
    val plan = Reconciler.reconcile(emptyList(), listOf(incoming("Send it", 1000, 2000)))
    assertNull(plan.rows.single().record)
  }
```

- [ ] **Step 2: Implement.** `AudioDb`:

```kotlin
  /** The classifier's five columns, carried as one so a reprocess cannot drop four of them. */
  data class Classified(
    val itemType: String?, val status: String?, val ownerJson: String?, val dateSaid: String?, val dateNorm: Long?,
  )
```

`StoredItem` gains `val record: Classified? = null` (last, defaulted). `items()` selects the five columns (APPEND to the projection — the positional note) and builds `record` when `item_type` is non-null. `Reconciler.Row` gains `val record: AudioDb.Classified? = null`; match rows pass `old.record`; rule-4 preserved rows pass `old.record`; fresh rows null. `replaceItems` writes `item_type,status,owner_json,date_said,date_norm` from `r.record` (nulls when absent) — the INSERT names all 14 columns now; delete the Phase A warning comment and replace it with one line saying the columns are carried.

New AudioDb methods:

```kotlin
  fun classifyItem(id: String, c: Classified, review: String, genVersion: String) {
    db.execSQL(
      "UPDATE items SET item_type=?,status=?,owner_json=?,date_said=?,date_norm=?,review=?,gen_version=? WHERE id=?",
      arrayOf<Any?>(c.itemType, c.status, c.ownerJson, c.dateSaid, c.dateNorm, review, genVersion, id),
    )
  }
```

JS (`queries.ts`): `Item` gains `itemType: string | null; status: string | null; ownerJson: string | null; dateSaid: string | null; dateNorm: number | null;` (types.ts), selected as `item_type AS itemType` etc.; `WHERE meeting_id = ? AND review <> 'rejected'`. Setters:

```ts
  setItemReview: (id: string, review: 'confirmed' | 'rejected') => run('UPDATE items SET review = ? WHERE id = ?', [review, id]),
  setItemOwner: (id: string, ownerJson: string) => run("UPDATE items SET owner_json = ?, review = 'confirmed' WHERE id = ?", [ownerJson, id]),
  setItemDate: (id: string, dateNorm: number | null) => run("UPDATE items SET date_norm = ?, review = 'confirmed' WHERE id = ?", [dateNorm, id]),
  setItemType: (id: string, itemType: string) => run("UPDATE items SET item_type = ?, review = 'confirmed' WHERE id = ?", [itemType, id]),
```

`date_said` is never written by a setter (spec: kept always).

- [ ] **Step 3: Rejected rows stay out of exports and search.** `FileExportModule` item query: `AND review <> 'rejected'`; `AudioDb.indexItems` likewise; `allActions` already does.

- [ ] **Step 4: Run** — ReconcilerTest, `python3 scripts/mutate-reconciler.py` (all mutants still caught; re-point a `find` string only if a patch stopped applying — never delete one), tsc, jest. Mutation-check: drop `old.record` from the match row: the carry test fails.

- [ ] **Step 5: Commit** — `git commit -m "feat(record): the five reserved columns are read, written and carried through a reprocess"`

---

### Task 6: `ItemClassifier` inside the narrate stage

**Files:**
- Create: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ItemClassifier.kt`
- Modify: `android/.../pipeline/Narrator.kt` (after the model loads, before digests)
- Modify: `android/.../pipeline/ProcessingEngine.kt` — nothing (the narrate stage already reports progress)

- [ ] **Step 1: Implement.**

```kotlin
package com.innocorelabs.verbale.pipeline

import android.util.Log
import com.innocorelabs.verbale.data.AudioDb
import org.json.JSONObject
import java.time.ZoneId

/**
 * The typed record for each rule-extracted item, read by the model through a grammar. Bounded on
 * purpose: it types what the rules found and never invents an item; it can only quote; every
 * answer is validated in C++ before it is believed. Pro only, by construction — it runs inside
 * narration, behind the one paid gate.
 */
object ItemClassifier {
  private const val TAG = "AudioPipeline"
  const val REPLY_WINDOW_TURNS = 4
  const val REPLY_WINDOW_MS = 90_000L
  const val RECORD_TOKENS = 96
  const val GEN_SUFFIX = "+qwen2.5-1.5b/classify@1"

  fun interface Generate { fun run(prompt: String, maxTokens: Int, grammar: String): String }

  /** Classifies every item of the meeting that has no record yet; returns how many it wrote. */
  fun run(db: AudioDb, meetingId: String, meetingAtMs: Long, gen: Generate, onEach: () -> Boolean): Int {
    val utts = db.utterances(meetingId)
    val speakers = db.speakers(meetingId).associate { it.id to (it.displayName ?: "Speaker") }
    val grammar = NativeBridge.nativeClassifyGrammar()
    var written = 0
    for (item in db.items(meetingId)) {
      if (item.record != null || item.review in AudioDb.Review.BY_A_PERSON) continue
      if (item.genVersion == AudioDb.Gen.USER) continue
      val src = item.sources.firstOrNull() ?: continue
      val at = utts.indexOfFirst { it.id == src.utteranceId }.takeIf { it >= 0 }
        ?: utts.indexOfFirst { it.startMs <= src.startMs && src.startMs <= it.endMs }.takeIf { it >= 0 }
        ?: continue
      // The window: the source line and the replies after it, bounded twice.
      val window = ArrayList<Utt>()
      for (i in at until utts.size) {
        val u = utts[i]
        if (window.size > REPLY_WINDOW_TURNS || u.startMs - utts[at].startMs > REPLY_WINDOW_MS) break
        window.add(u)
      }
      val ordinals = IntArray(window.size) { it }
      val names = Array(window.size) { speakers[window[it].speakerId] ?: "Speaker" }
      val texts = Array(window.size) { window[it].text }
      val prompt = NativeBridge.nativeClassifyPrompt(item.text, ordinals, names, texts)
      val raw = gen.run(prompt, RECORD_TOKENS, grammar)
      val json = NativeBridge.nativeValidateRecord(raw, ordinals, names, texts)
      if (json.isEmpty()) {
        Log.w(TAG, "classifier answer did not parse for ${item.id}: ${raw.take(120)}")
        continue
      }
      val r = JSONObject(json)
      val ownerKind = r.getJSONObject("owner").getString("kind")
      val ownerName = r.getJSONObject("owner").getString("name")
      val owner = when (ownerKind) {
        "speaker" -> JSONObject().put("kind", "speaker").put("id", utts[at].speakerId ?: "").put("confidence", r.getString("confidence"))
        "person" -> {
          val match = speakers.entries.firstOrNull { it.value.equals(ownerName, ignoreCase = true) }
          if (match != null) JSONObject().put("kind", "speaker").put("id", match.key).put("confidence", r.getString("confidence"))
          else JSONObject().put("kind", "person").put("name", ownerName).put("confidence", r.getString("confidence"))
        }
        else -> JSONObject().put("kind", "unassigned")
      }
      val dateSaid = r.getString("date_said").ifBlank { null }
      val dateNorm = dateSaid?.let { DateNorm.resolve(it, meetingAtMs, ZoneId.systemDefault()) }
      val decision = ReviewRule.decide(
        kind = item.kind, type = r.getString("type"), status = r.getString("status"),
        confidence = r.getString("confidence"), ownerKind = owner.getString("kind"),
        dateSaid = dateSaid, dateNorm = dateNorm, currentReview = item.review,
      )
      db.classifyItem(
        item.id,
        AudioDb.Classified(r.getString("type"), r.getString("status"), owner.toString(), dateSaid, dateNorm),
        decision.review, item.genVersion + GEN_SUFFIX,
      )
      Log.i(TAG, "classified ${item.id}: ${r.getString("type")}/${r.getString("status")} owner=${owner.getString("kind")} date=${dateSaid ?: "-"} -> ${decision.review}")
      written++
      if (onEach()) break
    }
    return written
  }
}
```

(`Utt` from `Minutes.kt`; `AudioDb.Gen.USER` is the user gen constant — read its actual name; `AudioDb.Review.BY_A_PERSON` exists.)

- [ ] **Step 2: Wire into `Narrator.run`** after `model loaded`: count the classifiable items first so the progress total includes them:

```kotlin
      val toClassify = db.items(meetingId).count { it.record == null && it.review !in AudioDb.Review.BY_A_PERSON }
      val total = (if (chunks.size == 1) 0 else chunks.size) + 3 + toClassify
      ...
      val classified = ItemClassifier.run(db, meetingId, meetingCreatedAt, { p, n, g ->
        NativeBridge.nativeLlmGenerateConstrained(handle, p, n, g)
      }) { step++; tick() }
      Log.i(TAG, "classified $classified item(s) for $meetingId")
```

`meetingCreatedAt` — read from `db.getMeeting(meetingId)`/the meetings row (`created_at`). Then the rest of narration unchanged.

- [ ] **Step 3: Compile; run Kotlin tests; `check-prompt-fencing`; build the APK.** Commit — `git commit -m "feat(record): ItemClassifier — one bounded, grammar-constrained reading per item, inside narration"`

---

## Part C — the queue

### Task 7: Labels on typed items, the banner, and rejected rows hidden

**Files:**
- Modify: `src/screens/meeting/shared.tsx` (`ItemRow` render: chips for `itemType`, `status ≠ open`, resolved owner, `dateNorm`)
- Modify: `src/screens/meeting/SummaryTab.tsx` (banner), `src/screens/MeetingScreen.tsx` (pass `onReview`)
- Tests: `src/screens/__tests__/MeetingScreen.test.tsx`

- [ ] **Step 1: Failing test** — with items `[{…, itemType:'request', status:'contradicted', review:'needs_review'}, {…, itemType:'commitment', review:'suggested'}]`, the Summary shows "1 item needs a look" and its "Review" navigates to `Review` with `{meetingId}`; with no `needs_review` classified items, no banner; with `review:'needs_review'` but `itemType: null` (a free-tier ambiguous match), no banner.

- [ ] **Step 2: Implement.** In `SummaryTab`, above the summary card:

```tsx
      {needsLook > 0 ? (
        <Raised edge={colors.warning} fill={colors.warningSoft} rad={radius.card} depth={4}>
          <Pressable accessibilityRole="button" accessibilityLabel="Review" onPress={onReview} style={st.reviewBanner}>
            <Icon name="alert" size={s(20)} color={colors.warning} strokeWidth={2.4} />
            <View style={st.flex}>
              <Txt variant="bodyBlack">{needsLook} item{needsLook === 1 ? '' : 's'} need{needsLook === 1 ? 's' : ''} a look</Txt>
              <Txt variant="chipSoft" color={colors.inkSoft}>What the model could not settle.</Txt>
            </View>
            <Txt variant="chip" color={colors.primary}>Review</Txt>
          </Pressable>
        </Raised>
      ) : null}
```

where `needsLook = items.filter(i => i.review === 'needs_review' && i.itemType !== null).length`. `MeetingScreen` passes `onReview={() => navigation.navigate('Review', { meetingId })}`. `RootNavigator`: `Review: { meetingId: string }`.

Label chips in `shared.tsx`'s item row (next to the owner/due chips): type (`sentenceCase(itemType)`, primary soft), status when not `open` (warning soft: "Qualified" / "Contradicted" / "Withdrawn"), and `dateNorm` as "→ Fri 18 Sep" after the spoken phrase.

- [ ] **Step 3: Run; mutation-check** (count `needs_review` regardless of `itemType`: the free-tier case fails). Commit — `git commit -m "feat(review): typed items wear their labels; the Summary says how many need a look"`

---

### Task 8: `ReviewScreen` — the card flow

**Files:**
- Create: `src/screens/ReviewScreen.tsx`, `src/screens/__tests__/ReviewScreen.test.tsx`
- Modify: `src/navigation/RootNavigator.tsx` (register)

- [ ] **Step 1: Failing test** — mocks `db.items` (two `needs_review` classified items), `db.utterances`, `db.speakers`, `db.getMeeting`, the setters. Confirm on card 1 → `db.setItemReview('i1','confirmed')` and card 2 shows ("2 of 2"); Not an item → `setItemReview('i2','rejected')` and `navigation.goBack()`; Fix on an owner-reason card → the speaker picker → pick → `setItemOwner('i1', '{"kind":"speaker","id":"s2","confidence":"high"}')`; Fix on a date-reason card → the day list → pick a day → `setItemDate('i1', <epoch>)`; "No date" → `setItemDate('i1', null)`.

- [ ] **Step 2: Implement.** Screen state: `queue` (items with `review === 'needs_review' && itemType`), `at` index, `fixing: 'owner' | 'date' | 'type' | null`. Card: the quote (`ProvenanceButton` from the Phase A components for play), chips (type; status with the cited turn's text and stamp when `status !== 'open'` — the cited turn is the item's first source utterance + the reply window; show the first utterance after the source whose text differs, with a play control), owner, date; the reason line from `reviewRule.decide(...)` (TS mirror); three buttons. Fix opens: owner → reuse `SpeakerPicker` (scopes=false, plus "Someone else…" → `TextPrompt` → `{kind:'person',name}`); date → a `Sheet` of the next 14 days from the meeting date labelled "Thu 17 Sep" … plus "No date" (no third-party picker; `date_said` untouched); type → a `Sheet` of the seven types. After Confirm/fix/reject: `at + 1`, or `goBack()` past the last.

- [ ] **Step 3: Run; mutation-check** (Confirm writes `rejected`: fails). Commit — `git commit -m "feat(review): the card flow — confirm, fix, or not an item"`

---

### Task 9: Prove it on the Pixel (Pro entitlement on the phone)

- [ ] **Grammar on device.** Add to `NativePipelineTest`: load the LLM (same helper as `llm_loads_and_generates`), build the lead-example window through `nativeClassifyPrompt`, generate with `nativeLlmGenerateConstrained` + `nativeClassifyGrammar`, assert `nativeValidateRecord` returns non-empty and its `type` is one of the seven — the grammar compiled and constrained. Run `scripts/device-verify.sh NativePipeline`.
- [ ] **The lead example.** Record with two `say` voices: *"Can you send the proposal Friday?"* / *"Only a draft; the final version needs another week."* / *"Fine, a draft then."* Stop; after processing (Pro): logcat `classified …: request/contradicted … date=Friday -> needs_review`; the Summary banner "1 item needs a look"; the card shows Request · Contradicted with the reply quoted and playable, "Friday" with no day; Confirm → banner gone; Redo → still confirmed (`review` and the record carried).
- [ ] **A clean commitment.** *"Priya will send the deck tomorrow."* → `commitment`, owner Priya (resolved to the speaker row if a speaker is named Priya, else person), `date_norm` = tomorrow, no card; the Actions tab shows the chips.
- [ ] **Free tier** (turn the entitlement off in Settings' debug or a fresh install): no labels, no banner.
- [ ] Record the run in the spec; NEXT.md; scorecard rows (typed record, review queue → ✅); memory. Commit; the push is the founder's.
