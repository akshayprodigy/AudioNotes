// The classifier against the real writer model on the Mac (VERBALE_LLM_GGUF), the way the phone
// runs it: the same prompt, the same grammar, the same sampler chain. Skips itself, exit 0,
// without the file. Prints the unconstrained and the constrained answer for every item of the
// lead-example meeting, so a change in either is visible, and asserts the one property a
// classifier must have to be worth a queue: it does not give six different statements the
// identical record.
#include "llm/llama_engine.h"
#include "minutes/evidence_record.h"

#include <cstdio>
#include <cstdlib>
#include <set>
#include <string>
#include <vector>

using namespace audionotes;

static int failures = 0;
#define CHECK(cond)                                                        \
  do {                                                                     \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                          \
    }                                                                      \
  } while (0)

struct Case { std::string item; std::vector<ClassifyTurn> window; };

static std::vector<Case> cases() {
  return {
      {"Can you send the proposal Friday?",
       {{0, "Speaker 1", "Great! Can you send the proposal Friday?"},
        {1, "Speaker 1", "Only a draft, the final version needs another week."},
        {2, "Speaker 1", "Fine, a draft then. Priya will send the deck tomorrow."}}},
      {"Priya will send the deck tomorrow.",
       {{0, "Speaker 1", "Fine, a draft then. Priya will send the deck tomorrow."},
        {1, "Speaker 1", "Sounds good. We also need to decide on the venue for the launch."}}},
      {"We agreed to ship on Monday, that is settled.",
       {{0, "Speaker 1", "We agreed to ship on Monday, that is settled."},
        {1, "Speaker 1", "Rahul pushed back on the pricing last week, so let's revisit that on Thursday."}}},
      {"We also need to decide on the venue for the launch.",
       {{0, "Speaker 1", "Sounds good. We also need to decide on the venue for the launch."},
        {1, "Speaker 1", "We agreed to ship on Monday, that is settled."}}},
  };
}

int main() {
  const char* path = std::getenv("VERBALE_LLM_GGUF");
  if (!path || !*path) { std::puts("test_classify_live: skipped (VERBALE_LLM_GGUF unset)"); return 0; }
  if (FILE* f = std::fopen(path, "rb")) std::fclose(f); else { std::printf("test_classify_live: skipped (%s not found)\n", path); return 0; }

  LlamaEngine e;
  if (!e.load(path, 8192, 4, /*greedy=*/true, /*repeat_penalty=*/1.15f)) { std::fprintf(stderr, "could not load\n"); return 1; }

  std::set<std::string> records;
  ItemRecord lead;
  bool leadParsed = false;
  for (const auto& c : cases()) {
    const std::string prompt = classifyPrompt(c.item, c.window);
    const std::string free = e.generate(prompt, 120);
    const std::string constrained = e.generateConstrained(prompt, 96, kClassifyGrammar);
    ItemRecord r;
    const bool parsed = parseRecord(constrained, &r);
    const ItemRecord v = parsed ? validateRecord(r, c.window) : ItemRecord{};
    std::printf("\n=== %s\n--- free:\n%s\n--- constrained:\n%s\n--- validated: %s\n", c.item.c_str(), free.c_str(),
                constrained.c_str(), parsed ? toJson(v).c_str() : "(unparsed)");
    if (parsed) records.insert(v.type + "/" + v.status + "/" + v.owner_kind + "/" + v.confidence);
    if (parsed && c.item == "Can you send the proposal Friday?") { lead = v; leadParsed = true; }
  }
  CHECK(records.size() >= 2);  // four different statements cannot honestly share one record
  // The improvement report's lead example — the case the whole design exists for. Greedy
  // decoding is deterministic, so this is a fixed expectation of THIS model and THIS prompt:
  // without the worked examples the same model reads it as request/open (measured 17 Sep).
  CHECK(leadParsed);
  CHECK(lead.type == "request");
  CHECK(lead.status == "contradicted");
  CHECK(lead.confidence == "high");
  if (failures) { std::fprintf(stderr, "test_classify_live: %d failure(s)\n", failures); return 1; }
  std::puts("test_classify_live: ok");
  return 0;
}
