// The cache lookup: exact boundaries only. A window whose start or end differs by a millisecond
// is a DIFFERENT window, and serving it would put one stretch of audio's words on another's
// timestamps. Model-free — this tests the lookup rule, not whisper.
#include "asr/asr_engine.h"

#include <cstdio>
#include <vector>

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

using audionotes::AsrCachedWindow;
using audionotes::Utterance;

// Mirrors WhisperAsr::Impl::cachedWindow. Kept here so the rule is pinned without linking
// whisper; if the two ever diverge, test_pipeline_align's transcripts change and say so.
static const std::vector<Utterance>* lookup(const std::vector<AsrCachedWindow>& cache,
                                            int64_t start_ms, int64_t end_ms) {
  for (const AsrCachedWindow& w : cache) {
    if (w.start_ms == start_ms && w.end_ms == end_ms) return &w.utterances;
  }
  return nullptr;
}

int main() {
  const std::vector<AsrCachedWindow> cache = {
    {0, 30000, {Utterance{0, 1000, "hello"}, Utterance{1000, 2000, "there"}}},
    {30000, 55000, {Utterance{0, 500, "again"}}},
  };

  CHECK(lookup(cache, 0, 30000) != nullptr, "exact match hits");
  CHECK(lookup(cache, 0, 30000)->size() == 2, "a window keeps all of its segments");
  CHECK(lookup(cache, 30000, 55000) != nullptr, "second window hits");
  CHECK(lookup(cache, 0, 29999) == nullptr, "end off by one misses");
  CHECK(lookup(cache, 1, 30000) == nullptr, "start off by one misses");
  CHECK(lookup(cache, 60000, 90000) == nullptr, "unknown window misses");
  CHECK(lookup({}, 0, 30000) == nullptr, "empty cache misses");

  // A cached window that decoded to nothing is a RESULT, not a miss. Storing it is what stops
  // the live loop retrying a genuinely silent window on every pass.
  {
    const std::vector<AsrCachedWindow> silent = {{0, 30000, {}}};
    CHECK(lookup(silent, 0, 30000) != nullptr, "an empty window still hits");
    CHECK(lookup(silent, 0, 30000)->empty(), "and yields no utterances");
  }

  // Timestamps are chunk-RELATIVE: that is what makes the value depend on the window's audio
  // and nothing about where the window sits in the meeting.
  CHECK(cache[1].utterances[0].start_ms == 0, "second window's first segment starts at 0");

  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_asr_cache: OK\n");
  return 0;
}
