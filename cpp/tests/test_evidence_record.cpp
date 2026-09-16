// The typed record: what the classifier may say, and what the validator lets through.
//
// The model can only quote. A name or a date it did not find verbatim in a cited turn is blanked
// and the record marked low-confidence; a status it cannot back with a second turn falls to open;
// a record that does not cite the turn the item came from is not a reading of that item at all.
// The lead example from the improvement report — a request in one turn, contradicted in the next —
// is the case the whole design exists for, and it validates whole.
#include "minutes/evidence_record.h"

#include <cstdio>
#include <string>
#include <vector>

using namespace audionotes;

// Not CHECK(): this target is built Release, where NDEBUG compiles every assert away and a test
// with nothing left to fail passes for having checked nothing. The same macro test_evidence uses.
static int failures = 0;
#define CHECK(cond)                                                        \
  do {                                                                     \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                          \
    }                                                                      \
  } while (0)

static std::vector<ClassifyTurn> leadExample() {
  return {
      {0, "Priya", "Can you send the proposal Friday?"},
      {1, "Rahul", "Only a draft; the final version needs another week."},
      {2, "Priya", "Fine, a draft then."},
  };
}

static void promptIsFencedAndNumbered() {
  const std::string p = classifyPrompt("Can you send the proposal Friday?", leadExample());
  CHECK(p.find("[0] Priya: Can you send the proposal Friday?") != std::string::npos);
  CHECK(p.find("[1] Rahul: Only a draft") != std::string::npos);
  // The transcript goes in through the fence, whose preamble names the material as a record.
  CHECK(p.find("RECORD OF A MEETING") != std::string::npos);
}

static void parserReadsTheGrammarsShape() {
  ItemRecord r;
  const bool ok = parseRecord(
      R"({"type":"request","status":"contradicted","owner":{"kind":"person","name":"Rahul"},)"
      R"("date_said":"Friday","cited":[0,1],"confidence":"high"})",
      &r);
  CHECK(ok);
  CHECK(r.type == "request");
  CHECK(r.status == "contradicted");
  CHECK(r.owner_kind == "person" && r.owner_name == "Rahul");
  CHECK(r.date_said == "Friday");
  CHECK(r.cited.size() == 2 && r.cited[0] == 0 && r.cited[1] == 1);
  CHECK(r.confidence == "high");
}

static void parserRejectsWhatTheGrammarWouldNever() {
  ItemRecord r;
  CHECK(!parseRecord("", &r));
  CHECK(!parseRecord(R"({"type":"request"})", &r));
  CHECK(!parseRecord(
      R"({"type":"fancy","status":"open","owner":{"kind":"unassigned","name":""},"date_said":"","cited":[0],"confidence":"high"})",
      &r));
}

static void validatorBlanksANonVerbatimName() {
  ItemRecord r;
  parseRecord(
      R"({"type":"commitment","status":"open","owner":{"kind":"person","name":"Priyanka"},"date_said":"Friday","cited":[0],"confidence":"high"})",
      &r);
  const ItemRecord v = validateRecord(r, leadExample());
  CHECK(v.owner_kind == "unassigned" && v.owner_name.empty());
  CHECK(v.confidence == "low");
  CHECK(v.date_said == "Friday");  // verbatim in turn 0: kept
}

static void validatorNeedsTheSourceCited() {
  ItemRecord r;
  parseRecord(
      R"({"type":"request","status":"open","owner":{"kind":"unassigned","name":""},"date_said":"","cited":[1],"confidence":"high"})",
      &r);
  const ItemRecord v = validateRecord(r, leadExample());
  CHECK(v.type == "uncertain");
  CHECK(v.confidence == "low");
}

static void validatorNeedsASecondTurnForAStatus() {
  ItemRecord r;
  parseRecord(
      R"({"type":"request","status":"contradicted","owner":{"kind":"unassigned","name":""},"date_said":"","cited":[0],"confidence":"high"})",
      &r);
  const ItemRecord v = validateRecord(r, leadExample());
  CHECK(v.status == "open");
}

static void theLeadExampleValidatesWhole() {
  ItemRecord r;
  parseRecord(
      R"({"type":"request","status":"contradicted","owner":{"kind":"speaker","name":""},"date_said":"Friday","cited":[0,1],"confidence":"high"})",
      &r);
  const ItemRecord v = validateRecord(r, leadExample());
  CHECK(v.type == "request" && v.status == "contradicted");
  CHECK(v.cited.size() == 2);
  CHECK(v.date_said == "Friday");
  CHECK(v.confidence == "high");
}

static void grammarNamesEveryEnumAndNothingElse() {
  const std::string g = kClassifyGrammar;
  for (const char* t : {"proposal", "agreement", "commitment", "request", "rejection", "unresolved",
                        "uncertain", "open", "qualified", "contradicted", "withdrawn", "speaker",
                        "person", "unassigned", "high", "low"}) {
    CHECK(g.find(std::string("\"\\\"") + t + "\\\"\"") != std::string::npos);
  }
  CHECK(g.find("root ::=") != std::string::npos);
}

static void toJsonRoundTrips() {
  ItemRecord r;
  parseRecord(
      R"({"type":"request","status":"contradicted","owner":{"kind":"person","name":"Rahul"},"date_said":"next Friday","cited":[0,1],"confidence":"high"})",
      &r);
  ItemRecord back;
  CHECK(parseRecord(toJson(r), &back));
  CHECK(back.owner_name == "Rahul");
  CHECK(back.cited.size() == 2);
  CHECK(back.date_said == r.date_said);
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
  toJsonRoundTrips();
  if (failures) {
    std::fprintf(stderr, "test_evidence_record: %d failure(s)\n", failures);
    return 1;
  }
  std::puts("test_evidence_record: ok");
  return 0;
}
