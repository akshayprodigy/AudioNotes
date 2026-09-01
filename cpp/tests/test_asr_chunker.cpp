// Pins chunk boundaries exactly as they shipped, so the commit that fixes the over-long-span
// defect has to say so by editing an assertion rather than by quietly producing different audio.
#include "asr/asr_chunker.h"

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

using audionotes::Chunk;
using audionotes::ChunkMode;
using audionotes::makeChunks;
using audionotes::Segment;

static void expectChunks(const std::vector<Chunk>& got,
                         const std::vector<Chunk>& want, const char* what) {
  CHECK(got.size() == want.size(), "%s: got %zu chunks, want %zu", what, got.size(), want.size());
  if (got.size() != want.size()) return;
  for (size_t i = 0; i < got.size(); ++i) {
    CHECK(got[i].start_ms == want[i].start_ms && got[i].end_ms == want[i].end_ms,
          "%s[%zu]: got [%lld,%lld], want [%lld,%lld]", what, i,
          (long long)got[i].start_ms, (long long)got[i].end_ms,
          (long long)want[i].start_ms, (long long)want[i].end_ms);
  }
}

int main() {
  const int64_t kBudget = 30000;

  expectChunks(makeChunks({}, kBudget), {}, "empty input");

  expectChunks(makeChunks({{0, 5000}}, kBudget), {{0, 5000}}, "single span");

  // Two spans inside the budget merge, and the chunk spans the GAP between them too.
  expectChunks(makeChunks({{0, 5000}, {6000, 10000}}, kBudget), {{0, 10000}}, "packed");

  // The budget is measured from the chunk's START, not from accumulated speech.
  expectChunks(makeChunks({{0, 5000}, {40000, 45000}}, kBudget),
               {{0, 5000}, {40000, 45000}}, "second span past the budget starts a new chunk");

  // Boundary: ending exactly AT the budget still packs (the test is >, not >=).
  expectChunks(makeChunks({{0, 5000}, {25000, 30000}}, kBudget), {{0, 30000}}, "exactly at budget");
  expectChunks(makeChunks({{0, 5000}, {25000, 30001}}, kBudget),
               {{0, 5000}, {25000, 30001}}, "one ms past the budget");

  // THE DEFECT, pinned. A 120 s uninterrupted span becomes ONE 120 s chunk — four times the
  // budget. whisper hides this by re-windowing internally; a token-budgeted engine truncates.
  // When this assertion is changed, the commit doing it is changing decoded audio on purpose.
  expectChunks(makeChunks({{0, 120000}}, kBudget), {{0, 120000}},
               "DEFECT: over-long span is not split");

  // kPerSpan never merges, which is what keeps utterances turn-shaped for an engine that
  // returns one untimestamped result per window.
  expectChunks(makeChunks({{0, 5000}, {6000, 10000}}, kBudget, ChunkMode::kPerSpan),
               {{0, 5000}, {6000, 10000}}, "per-span does not pack");

  if (failures == 0) std::printf("test_asr_chunker OK\n");
  return failures == 0 ? 0 : 1;
}
