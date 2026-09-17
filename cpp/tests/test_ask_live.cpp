// Ask against the real writer on the Mac (VERBALE_LLM_GGUF), the way the phone runs it: the
// lead-example passages, the question the spec names, the same sampler chain. Skips itself,
// exit 0, without the file. Prints the raw and validated answer so a change in either is seen.
#include "llm/llama_engine.h"
#include "minutes/ask.h"

#include <cstdio>
#include <cstdlib>
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

int main() {
  const char* path = std::getenv("VERBALE_LLM_GGUF");
  if (!path || !*path) { std::puts("test_ask_live: skipped (VERBALE_LLM_GGUF unset)"); return 0; }
  if (FILE* f = std::fopen(path, "rb")) std::fclose(f); else { std::printf("test_ask_live: skipped (%s not found)\n", path); return 0; }

  LlamaEngine e;
  if (!e.load(path, 8192, 4, /*greedy=*/true, /*repeat_penalty=*/1.15f)) { std::fprintf(stderr, "could not load\n"); return 1; }

  const std::vector<AskPassage> ps = {
      {"Speaker 1", 8000, "Good morning everyone! Let's get started with the proposal for the new client. Sure, I have been through the draft and the numbers look right to me. Great! Can you send the proposal Friday? Only a draft, the final version needs another week. Fine, a draft then. Prey will send the deck tomorrow."},
      {"Minutes", 20000, "Can you send the proposal Friday?"},
      {"Minutes", 29000, "Prey will send the deck tomorrow. — Prey (due tomorrow)"},
      {"Minutes", 40000, "We agreed to ship on Monday, that is settled."},
  };
  struct Q { std::string q; bool expectAnswer; };
  for (const Q& q : {Q{"did we agree on a date for the proposal?", true}, Q{"who won the cricket match?", false}}) {
    const std::string prompt = askPrompt(q.q, ps);
    const std::string raw = e.generateConstrained(prompt, 200, askGrammar(static_cast<int>(ps.size())));
    const AskAnswer a = validateAnswer(raw, static_cast<int>(ps.size()));
    std::printf("\n=== %s\n--- raw:\n%s\n--- validated: nothing=%d cites=%zu text=%s\n", q.q.c_str(), raw.c_str(),
                a.nothing ? 1 : 0, a.cites.size(), a.text.c_str());
    // Never an echo of a passage, whatever else the model does.
    CHECK(a.text.find("(0:08):") == std::string::npos);
    if (q.expectAnswer) {
      CHECK(!a.nothing);
      CHECK(!a.cites.empty());
    }
  }
  if (failures) { std::fprintf(stderr, "test_ask_live: %d failure(s)\n", failures); return 1; }
  std::puts("test_ask_live: ok");
  return 0;
}
