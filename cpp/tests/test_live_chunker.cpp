// The live pass must emit a chunk only when no future span could still be packed into it.
// Emitting early is not a correctness bug — the key simply misses and the post-hoc pass decodes
// normally — but it wastes exactly the CPU this feature exists to save.
#include "asr/live_chunker.h"

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
using audionotes::finalChunks;
using audionotes::makeChunks;
using audionotes::Segment;

static const int64_t kBudget = 30000;

static void sameChunks(const std::vector<Chunk>& got, const std::vector<Chunk>& want,
                       const char* what) {
  CHECK(got.size() == want.size(), "%s: got %zu chunks, want %zu", what, got.size(), want.size());
  if (got.size() != want.size()) return;
  for (size_t i = 0; i < got.size(); ++i) {
    CHECK(got[i].start_ms == want[i].start_ms && got[i].end_ms == want[i].end_ms,
          "%s[%zu]: got [%lld,%lld], want [%lld,%lld]", what, i,
          (long long)got[i].start_ms, (long long)got[i].end_ms,
          (long long)want[i].start_ms, (long long)want[i].end_ms);
  }
}

static void collect(std::vector<Chunk>& into, const std::vector<Chunk>& more) {
  for (const Chunk& c : more) {
    bool seen = false;
    for (const Chunk& e : into) {
      if (e.start_ms == c.start_ms && e.end_ms == c.end_ms) { seen = true; break; }
    }
    if (!seen) into.push_back(c);
  }
}

int main() {
  // Nothing captured yet.
  sameChunks(finalChunks({}, -1, 0, kBudget), {}, "empty");

  // One span, silence still short of the merge gap: the next span could still join it.
  sameChunks(finalChunks({{0, 5000}}, -1, 10000, kBudget), {}, "gap not yet elapsed");

  // Same span, 12 s of silence past its end and nothing pending: now it cannot grow.
  sameChunks(finalChunks({{0, 5000}}, -1, 17000, kBudget), {{0, 5000}}, "gap elapsed");

  // THE REGRESSION CASE. Someone is still talking, having started 5 s after the chunk ended.
  // The frontier is far past the 12 s gap, so a frontier-only rule would wrongly call this
  // final — but when that span closes, makeChunks packs it into the SAME chunk.
  sameChunks(finalChunks({{0, 5000}}, 10000, 30000, kBudget), {}, "pending span can still join");

  // A pending span that starts beyond the merge gap cannot join, so the chunk is final.
  sameChunks(finalChunks({{0, 5000}}, 20000, 25000, kBudget), {{0, 5000}}, "pending span too far");

  // A closed span past the chunk means makeChunks already decided with full knowledge.
  {
    const std::vector<Segment> spans = {{0, 5000}, {20000, 25000}};
    sameChunks(finalChunks(spans, -1, 26000, kBudget), {{0, 5000}}, "later span closes the first");
  }

  // The property that matters: replaying a meeting span by span must emit exactly what the
  // offline chunker produces over the whole list — same boundaries, same order, no extras.
  {
    const std::vector<Segment> all = {
      {0, 4000}, {5000, 9000},        // close together: one chunk
      {30000, 34000},                 // 21 s gap: new chunk
      {35000, 60000}, {61000, 92000}, // budget forces a split
      {200000, 203000},               // long silence: new chunk
    };
    std::vector<Chunk> collected;
    for (size_t n = 1; n <= all.size(); ++n) {
      const std::vector<Segment> prefix(all.begin(), all.begin() + n);
      // The frontier sits just past the last released span; the next span is not known yet.
      const int64_t captured = prefix.back().end_ms + 1;
      collect(collected, finalChunks(prefix, -1, captured, kBudget));
    }
    // End of capture: everything is final.
    collect(collected, finalChunks(all, -1, all.back().end_ms + 60000, kBudget));
    sameChunks(collected, makeChunks(all, kBudget), "incremental == offline");
  }

  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_live_chunker: OK\n");
  return 0;
}
