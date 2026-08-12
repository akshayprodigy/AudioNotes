// Replays the goldens written by src/pipeline/__tests__/minutes.golden.test.ts against the C++
// port. argv[1] = golden dir. Exits non-zero with a diff on the first mismatch.
#include "minutes/minutes_extractor.h"

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

static json load(const std::string& dir, const char* name) {
  std::ifstream f(dir + "/" + name);
  if (!f) { std::fprintf(stderr, "missing golden %s\n", name); std::exit(2); }
  return json::parse(f);
}

static void runMinutesGolden(const std::string& dir, const char* name) {
  json g = load(dir, name);
  std::vector<audionotes::MinuteUtt> utts;
  for (const auto& u : g["input"]["utterances"])
    utts.push_back({u["text"].get<std::string>(),
                    u.contains("speakerId") && !u["speakerId"].is_null()
                        ? u["speakerId"].get<std::string>() : ""});
  std::vector<audionotes::MinuteSpk> spks;
  for (const auto& s : g["input"]["speakers"])
    spks.push_back({s["id"].get<std::string>(), s["displayName"].get<std::string>()});

  auto got = audionotes::extractMinutes(utts, spks);
  const auto& want = g["output"];
  CHECK(got.size() == want.size(), "%s: size %zu != %zu", name, got.size(), want.size());
  for (size_t i = 0; i < got.size() && i < want.size(); ++i) {
    CHECK(got[i].kind == want[i]["kind"].get<std::string>(), "%s[%zu].kind '%s' != '%s'", name,
          i, got[i].kind.c_str(), want[i]["kind"].get<std::string>().c_str());
    CHECK(got[i].content == want[i]["content"].get<std::string>(), "%s[%zu].content\n  got: %s\n want: %s",
          name, i, got[i].content.c_str(), want[i]["content"].get<std::string>().c_str());
  }
}

int main(int argc, char** argv) {
  if (argc < 2) { std::fprintf(stderr, "usage: test_minutes <golden-dir>\n"); return 2; }
  const std::string dir = argv[1];
  runMinutesGolden(dir, "minutes_meeting.json");
  runMinutesGolden(dir, "minutes_dedup.json");
  runMinutesGolden(dir, "minutes_priority.json");

  // Caps: 35 distinct action sentences -> 30 actions kept; summary counts the trimmed list.
  {
    std::vector<audionotes::MinuteUtt> many;
    for (int i = 0; i < 35; ++i)
      many.push_back({"We need to fix bug number " + std::to_string(i) + ".", ""});
    auto m = audionotes::extractMinutes(many, {});
    int actions = 0;
    for (const auto& d : m) if (d.kind == "action") ++actions;
    CHECK(actions == 30, "caps: got %d actions, want 30", actions);
    CHECK(!m.empty() && m[0].kind == "summary" &&
          m[0].content.rfind("30 action items", 0) == 0,
          "caps summary: '%s'", m.empty() ? "(empty)" : m[0].content.c_str());
  }

  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_minutes OK\n");
  return 0;
}
