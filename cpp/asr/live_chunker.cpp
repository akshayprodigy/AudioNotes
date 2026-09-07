#include "asr/live_chunker.h"

namespace audionotes {

std::vector<Chunk> finalChunks(const std::vector<Segment>& spans,
                               int64_t pending_span_start_ms,
                               int64_t captured_ms,
                               int64_t max_chunk_ms,
                               ChunkMode mode,
                               int64_t max_gap_ms) {
  // Chunk the spans we have. Every chunk but the LAST is necessarily final already: a chunk is
  // only closed by a span that follows it, and makeChunks made that decision knowing that span.
  // The loop still tests each one rather than special-casing the last, because the invariant is
  // worth stating in code that checks it.
  const std::vector<Chunk> all = makeChunks(spans, max_chunk_ms, mode, max_gap_ms);
  std::vector<Chunk> out;
  for (const Chunk& c : all) {
    bool closed_by_a_later_span = false;
    for (const Segment& s : spans) {
      if (s.start_ms > c.end_ms) { closed_by_a_later_span = true; break; }
    }
    if (closed_by_a_later_span) { out.push_back(c); continue; }

    // Nothing released past this chunk. Anything the VAD is holding is the candidate joiner.
    if (pending_span_start_ms >= 0 && pending_span_start_ms > c.end_ms) {
      if (pending_span_start_ms - c.end_ms > max_gap_ms) out.push_back(c);
      continue;
    }
    // Nothing held either, so any future span must begin after the capture frontier.
    if (captured_ms - c.end_ms >= max_gap_ms) out.push_back(c);
  }
  return out;
}

}  // namespace audionotes
