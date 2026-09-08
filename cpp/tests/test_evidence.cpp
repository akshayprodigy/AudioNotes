// Replays the goldens written by src/pipeline/__tests__/minutes.golden.test.ts against the C++
// port. argv[1] = golden dir. Exits non-zero with a diff on the first mismatch.
#include "minutes/evidence.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>

#include "nlohmann/json.hpp"

using nlohmann::json;

static int failures = 0;
#define CHECK(cond, ...)                                        \
  do {                                                          \
    if (!(cond)) {                                              \
      std::fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      std::fprintf(stderr, __VA_ARGS__);                        \
      std::fprintf(stderr, "\n");                               \
      ++failures;                                               \
    }                                                           \
  } while (0)

static json load(const std::string& dir, const char* name) {
  std::ifstream f(dir + "/" + name);
  if (!f) { std::fprintf(stderr, "missing golden %s\n", name); std::exit(2); }
  return json::parse(f);
}

static void runGolden(const std::string& dir, const char* name) {
  json g = load(dir, name);
  std::vector<audionotes::TimedUtt> utts;
  for (const auto& u : g["input"]["utterances"])
    utts.push_back({u["id"].get<std::string>(), u["startMs"].get<int64_t>(),
                    u["endMs"].get<int64_t>(),
                    u.contains("speakerId") && !u["speakerId"].is_null()
                        ? u["speakerId"].get<std::string>() : "",
                    u["text"].get<std::string>()});
  std::vector<audionotes::MinuteSpk> spks;
  for (const auto& s : g["input"]["speakers"])
    spks.push_back({s["id"].get<std::string>(), s["displayName"].get<std::string>()});

  auto got = audionotes::extractItems(utts, spks);
  const auto& want = g["output"];
  CHECK(got.size() == want.size(), "%s: size %zu != %zu", name, got.size(), want.size());
  for (size_t i = 0; i < got.size() && i < want.size(); ++i) {
    CHECK(got[i].kind == want[i]["kind"].get<std::string>(), "%s[%zu].kind '%s' != '%s'", name, i,
          got[i].kind.c_str(), want[i]["kind"].get<std::string>().c_str());
    CHECK(got[i].text == want[i]["text"].get<std::string>(), "%s[%zu].text\n  got: %s\n want: %s",
          name, i, got[i].text.c_str(), want[i]["text"].get<std::string>().c_str());
    CHECK(got[i].anchor_start_ms == want[i]["anchorStartMs"].get<int64_t>(),
          "%s[%zu].anchorStartMs %lld != %lld", name, i, (long long)got[i].anchor_start_ms,
          (long long)want[i]["anchorStartMs"].get<int64_t>());
    CHECK(got[i].anchor_end_ms == want[i]["anchorEndMs"].get<int64_t>(),
          "%s[%zu].anchorEndMs %lld != %lld", name, i, (long long)got[i].anchor_end_ms,
          (long long)want[i]["anchorEndMs"].get<int64_t>());
    const auto& ws = want[i]["sources"];
    CHECK(got[i].sources.size() == ws.size(), "%s[%zu].sources %zu != %zu", name, i,
          got[i].sources.size(), ws.size());
    for (size_t j = 0; j < got[i].sources.size() && j < ws.size(); ++j) {
      CHECK(got[i].sources[j].utterance_id == ws[j]["utteranceId"].get<std::string>(),
            "%s[%zu].sources[%zu].utteranceId '%s' != '%s'", name, i, j,
            got[i].sources[j].utterance_id.c_str(),
            ws[j]["utteranceId"].get<std::string>().c_str());
      CHECK(got[i].sources[j].start_ms == ws[j]["startMs"].get<int64_t>(),
            "%s[%zu].sources[%zu].startMs mismatch", name, i, j);
      CHECK(got[i].sources[j].end_ms == ws[j]["endMs"].get<int64_t>(),
            "%s[%zu].sources[%zu].endMs mismatch", name, i, j);
      CHECK(got[i].sources[j].char_start == ws[j]["charStart"].get<int32_t>(),
            "%s[%zu].sources[%zu].charStart %d != %d", name, i, j,
            got[i].sources[j].char_start, ws[j]["charStart"].get<int32_t>());
      CHECK(got[i].sources[j].char_end == ws[j]["charEnd"].get<int32_t>(),
            "%s[%zu].sources[%zu].charEnd %d != %d", name, i, j,
            got[i].sources[j].char_end, ws[j]["charEnd"].get<int32_t>());
    }
  }
}

int main(int argc, char** argv) {
  if (argc < 2) { std::fprintf(stderr, "usage: test_evidence <golden-dir>\n"); return 2; }
  const std::string dir = argv[1];
  // This list must match exactly what src/pipeline/__tests__/minutes.golden.test.ts writes. A
  // golden the C++ never replays is not a parity test, it is a file - and the set grew after
  // review: cross-turn anchor widening, decision-over-action precedence, a null speakerId, an
  // empty input and the UTF-16 row were all added because a wrong port passed without them.
  // Check the writeEvidenceGolden calls in that file before trusting this list.
  runGolden(dir, "evidence_meeting.json");
  runGolden(dir, "evidence_dedup.json");
  runGolden(dir, "evidence_spans.json");
  runGolden(dir, "evidence_decision_dedup.json");
  runGolden(dir, "evidence_priority.json");
  runGolden(dir, "evidence_unassigned.json");
  runGolden(dir, "evidence_empty.json");
  runGolden(dir, "evidence_caps.json");
  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_evidence: OK\n");
  return 0;
}
