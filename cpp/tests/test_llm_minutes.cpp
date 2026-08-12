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

  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_llm_minutes OK\n");
  return 0;
}
