#include "asr/asr_chunker.h"

namespace audionotes {

std::vector<Chunk> makeChunks(const std::vector<Segment>& segs, int64_t max_chunk_ms,
                              ChunkMode mode) {
  std::vector<Chunk> chunks;
  if (mode == ChunkMode::kPerSpan) {
    for (const auto& s : segs) chunks.push_back(Chunk{s.start_ms, s.end_ms});
    return chunks;
  }
  // Verbatim from whisper_asr.cpp:48-58. Do not "tidy" this — it is under characterization until
  // the commit that changes it on purpose.
  for (const auto& s : segs) {
    if (chunks.empty() || s.end_ms - chunks.back().start_ms > max_chunk_ms) {
      chunks.push_back(Chunk{s.start_ms, s.end_ms});
    } else {
      chunks.back().end_ms = s.end_ms;
    }
  }
  return chunks;
}

}  // namespace audionotes
