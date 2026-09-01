#include "asr/asr_chunker.h"

#include <algorithm>

namespace audionotes {

namespace {

// Append [start_ms, end_ms), split into equal contiguous windows none longer than the budget.
//
// EQUAL parts rather than greedy budget-sized ones. Greedy leaves a remainder, and the
// pathological remainder is the reason to care: a 30,001 ms span at a 30,000 ms budget would
// become a full window plus a ONE MILLISECOND window — an entire decoder invocation on nothing.
// Ceiling division into equal parts cannot produce a sliver.
void appendSplit(std::vector<Chunk>* out, int64_t start_ms, int64_t end_ms, int64_t max_chunk_ms) {
  const int64_t len = end_ms - start_ms;
  if (max_chunk_ms <= 0 || len <= max_chunk_ms) {
    out->push_back(Chunk{start_ms, end_ms});
    return;
  }
  const int64_t parts = (len + max_chunk_ms - 1) / max_chunk_ms;
  const int64_t step = (len + parts - 1) / parts;
  for (int64_t t = start_ms; t < end_ms; t += step) {
    out->push_back(Chunk{t, std::min(t + step, end_ms)});
  }
}

}  // namespace

std::vector<Chunk> makeChunks(const std::vector<Segment>& segs, int64_t max_chunk_ms,
                              ChunkMode mode) {
  std::vector<Chunk> chunks;

  if (mode == ChunkMode::kPerSpan) {
    // One window per speech span, so an engine that returns a single untimestamped result per
    // window still produces turn-shaped utterances. A span can exceed the budget on its own, and
    // that is precisely the engine whose decoder truncates silently, so it is split too.
    for (const auto& s : segs) appendSplit(&chunks, s.start_ms, s.end_ms, max_chunk_ms);
    return chunks;
  }

  // Pack spans up to the budget, measured from the chunk's start. Packing can only ever produce
  // an over-long window when a SINGLE span is longer than the budget, so splitting afterwards is
  // enough and keeps the packing decision itself untouched.
  std::vector<Chunk> packed;
  for (const auto& s : segs) {
    if (packed.empty() || s.end_ms - packed.back().start_ms > max_chunk_ms) {
      packed.push_back(Chunk{s.start_ms, s.end_ms});
    } else {
      packed.back().end_ms = s.end_ms;
    }
  }
  for (const auto& c : packed) appendSplit(&chunks, c.start_ms, c.end_ms, max_chunk_ms);
  return chunks;
}

}  // namespace audionotes
