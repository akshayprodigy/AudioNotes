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

  // Was the defect: a 120 s uninterrupted span used to become ONE 120 s chunk, four times the
  // budget. whisper hid it by re-windowing internally; a token-budgeted engine truncates instead.
  // Now split into equal contiguous windows, none over budget and no audio dropped between them.
  expectChunks(makeChunks({{0, 120000}}, kBudget),
               {{0, 30000}, {30000, 60000}, {60000, 90000}, {90000, 120000}},
               "over-long span is split at the budget");

  // EQUAL parts, not greedy budget-sized ones. Greedy would leave a remainder window, and the
  // pathological remainder is the point: a 30,001 ms span would become a 30,000 ms window plus a
  // ONE MILLISECOND window — a whole decoder invocation on nothing. Equal parts cannot do that.
  expectChunks(makeChunks({{0, 45000}}, kBudget), {{0, 22500}, {22500, 45000}},
               "split into equal halves, not 30000 + 15000");
  expectChunks(makeChunks({{0, 30001}}, kBudget), {{0, 15001}, {15001, 30001}},
               "one ms over budget does not produce a one ms sliver");

  // Contiguous: the end of each window is the start of the next, so nothing is skipped.
  {
    const auto cs = makeChunks({{0, 100000}}, kBudget);
    for (size_t i = 1; i < cs.size(); ++i) {
      CHECK(cs[i].start_ms == cs[i - 1].end_ms, "gap between window %zu and %zu", i - 1, i);
    }
    for (const auto& c : cs) {
      CHECK(c.end_ms - c.start_ms <= kBudget, "window of %lld ms exceeds budget",
            (long long)(c.end_ms - c.start_ms));
    }
  }

  // A long span must be split in kPerSpan too — a VAD span can exceed the budget on its own,
  // and that is exactly the engine whose decoder truncates silently.
  {
    const auto cs = makeChunks({{0, 60000}}, 25000, ChunkMode::kPerSpan);
    CHECK(cs.size() == 3, "per-span split into %zu windows, want 3", cs.size());
    for (const auto& c : cs) {
      CHECK(c.end_ms - c.start_ms <= 25000, "per-span window exceeds budget");
    }
  }

  // kPerSpan never merges, which is what keeps utterances turn-shaped for an engine that
  // returns one untimestamped result per window.
  expectChunks(makeChunks({{0, 5000}, {6000, 10000}}, kBudget, ChunkMode::kPerSpan),
               {{0, 5000}, {6000, 10000}}, "per-span does not pack");

  if (failures == 0) std::printf("test_asr_chunker OK\n");
  return failures == 0 ? 0 : 1;
}
