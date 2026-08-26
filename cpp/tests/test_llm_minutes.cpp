// Golden parity for parseMinutesJson (fixtures from summarize.ts via the jest golden test) plus
// direct unit tests for chunking and the map/reduce plumbing (fake generate fn).
#include "minutes/llm_minutes.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>

#include "nlohmann/json.hpp"

using nlohmann::json;

static int failures = 0;
#define CHECK(cond, ...)                                   \
  do {                                                     \
    if (!(cond)) {                                         \
      std::fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      std::fprintf(stderr, __VA_ARGS__);                   \
      std::fprintf(stderr, "\n");                          \
      ++failures;                                          \
    }                                                      \
  } while (0)

static void runParseGolden(const std::string& dir, const char* name) {
  std::ifstream f(dir + "/" + name);
  if (!f) { std::fprintf(stderr, "missing golden %s\n", name); std::exit(2); }
  json g = json::parse(f);
  auto got = audionotes::parseMinutesJson(g["input"].get<std::string>());
  if (g["output"].is_null()) {
    CHECK(!got.has_value(), "%s: expected null, got %zu minutes", name,
          got ? got->size() : static_cast<size_t>(0));
    return;
  }
  CHECK(got.has_value(), "%s: expected minutes, got null", name);
  if (!got) return;
  const auto& want = g["output"];
  CHECK(got->size() == want.size(), "%s: size %zu != %zu", name, got->size(), want.size());
  for (size_t i = 0; i < got->size() && i < want.size(); ++i) {
    CHECK((*got)[i].kind == want[i]["kind"].get<std::string>(), "%s[%zu].kind", name, i);
    CHECK((*got)[i].content == want[i]["content"].get<std::string>(),
          "%s[%zu].content\n  got: %s\n want: %s", name, i, (*got)[i].content.c_str(),
          want[i]["content"].get<std::string>().c_str());
    CHECK((*got)[i].source == "llm", "%s[%zu].source", name, i);
  }
}

int main(int argc, char** argv) {
  if (argc < 2) { std::fprintf(stderr, "usage: test_llm_minutes <golden-dir>\n"); return 2; }
  const std::string dir = argv[1];
  runParseGolden(dir, "parse_valid.json");
  runParseGolden(dir, "parse_template_echo.json");
  runParseGolden(dir, "parse_broken.json");
  runParseGolden(dir, "parse_string_actions.json");
  runParseGolden(dir, "parse_na_due.json");

  // chunkTranscript: lines pack up to max_chars with '\n' joins; oversize single line stays whole.
  {
    std::vector<std::string> lines = {std::string(10, 'a'), std::string(10, 'b'),
                                      std::string(10, 'c')};
    auto chunks = audionotes::chunkTranscript(lines, 25);
    CHECK(chunks.size() == 2, "chunking: got %zu chunks, want 2", chunks.size());
    CHECK(chunks[0] == std::string(10, 'a') + "\n" + std::string(10, 'b'), "chunk[0] content");
    CHECK(chunks[1] == std::string(10, 'c'), "chunk[1] content");
  }

  // transcriptLines: names resolve; missing speaker -> "Speaker".
  {
    auto lines = audionotes::transcriptLines(
        {{"Hello.", "S0"}, {"World.", ""}},
        {{"S0", "Speaker 1"}});
    CHECK(lines.size() == 2 && lines[0] == "Speaker 1: Hello." && lines[1] == "Speaker: World.",
          "transcriptLines: %s | %s", lines[0].c_str(), lines[1].c_str());
  }

  // enhanceMinutes single-chunk path: notes = raw chunk (no map), one reduce call at 768 tokens.
  {
    int calls = 0;
    std::string seen_prompt;
    auto fake = [&](const std::string& prompt, int max_tokens) {
      ++calls;
      seen_prompt = prompt;
      CHECK(max_tokens == 768, "single-chunk reduce max_tokens %d != 768", max_tokens);
      return std::string(
          "{\"summary\":\"Short meeting.\",\"decisions\":[],\"actions\":[],\"questions\":[]}");
    };
    auto out = audionotes::enhanceMinutes({{"Hi there.", "S0"}}, {{"S0", "Speaker 1"}}, fake);
    CHECK(calls == 1, "single-chunk path made %d generate calls, want 1", calls);
    CHECK(seen_prompt.find("Speaker 1: Hi there.") != std::string::npos, "notes not in prompt");
    CHECK(out && out->size() == 1 && (*out)[0].kind == "summary", "single-chunk parse");
  }

  // enhanceMinutes empty input -> nullopt.
  CHECK(!audionotes::enhanceMinutes({}, {}, [](const std::string&, int) { return std::string(); }),
        "empty utterances must return nullopt");

  // Prompt builders: each must embed its input and must NOT ask for JSON. The summary prompt in
  // particular must not inherit the extraction schema's framing, which made the model describe
  // what it failed to find instead of what happened.
  {
    const std::string n = audionotes::narrativePrompt("ZZNOTESZZ");
    CHECK(n.find("ZZNOTESZZ") != std::string::npos, "narrativePrompt drops its input");
    CHECK(n.find("JSON") == std::string::npos, "narrativePrompt must not ask for JSON");

    const std::string s = audionotes::summaryPrompt("ZZNARRATIVEZZ");
    CHECK(s.find("ZZNARRATIVEZZ") != std::string::npos, "summaryPrompt drops its input");
    CHECK(s.find("JSON") == std::string::npos, "summaryPrompt must not ask for JSON");
    CHECK(s.find("2") != std::string::npos, "summaryPrompt must state a sentence count");

    const std::string h = audionotes::headlinePrompt("ZZSUMMARYZZ");
    CHECK(h.find("ZZSUMMARYZZ") != std::string::npos, "headlinePrompt drops its input");
    CHECK(h.find("15") != std::string::npos, "headlinePrompt must state a word budget");
  }

  // foldPlan: empty when the notes already fit; otherwise groups of >= 2 covering every note in
  // order, each group's joined length within budget.
  {
    std::vector<std::string> small = {std::string(10, 'a'), std::string(10, 'b')};
    CHECK(audionotes::foldPlan(small, 100).empty(), "foldPlan should be empty when notes fit");

    std::vector<std::string> big;
    for (int i = 0; i < 6; ++i) big.push_back(std::string(40, 'x'));
    const auto plan = audionotes::foldPlan(big, 100);
    CHECK(!plan.empty(), "foldPlan should group when notes exceed the budget");

    size_t covered = 0;
    int last = -1;
    for (const auto& group : plan) {
      CHECK(group.size() >= 2, "a fold group of one note does no work");
      size_t joined = 0;
      for (int idx : group) {
        CHECK(idx > last, "fold groups must cover notes in order without repeats");
        last = idx;
        joined += big[static_cast<size_t>(idx)].size() + 2;
        ++covered;
      }
      CHECK(joined <= 100 + 2, "fold group %zu exceeds the budget", joined);
    }
    CHECK(covered == big.size(), "foldPlan covered %zu of %zu notes", covered, big.size());

    // A single note larger than the whole budget cannot be folded with anything — it must not be
    // silently dropped, and it must not wedge the caller in an infinite fold loop.
    std::vector<std::string> huge = {std::string(500, 'y'), std::string(10, 'z')};
    const auto hplan = audionotes::foldPlan(huge, 100);
    for (const auto& group : hplan) CHECK(group.size() >= 2, "no single-note groups for oversize notes");
  }

  // foldPrompt keeps the notes format so folded output can be folded again.
  {
    const std::string f = audionotes::foldPrompt("ZZNOTESZZ");
    CHECK(f.find("ZZNOTESZZ") != std::string::npos, "foldPrompt drops its input");
    CHECK(f.find("DECISIONS") != std::string::npos, "foldPrompt must ask for the notes format back");
  }

  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_llm_minutes OK\n");
  return 0;
}
