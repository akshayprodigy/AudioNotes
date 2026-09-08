// Which decode windows are FINAL while a meeting is still being recorded.
//
// The live pass caches a chunk's decode under a key made of its boundaries. If it emits a chunk
// that the finished recording would have packed differently, the post-hoc pass asks for a key
// that was never stored and decodes it again — correct, but the CPU was wasted, which is the one
// thing this feature exists to avoid. So a chunk is emitted only when no future span can join it.
#pragma once
#include <cstdint>
#include <vector>

#include "asr/asr_chunker.h"  // Chunk, makeChunks, kMaxMergeGapMs; Segment via vad/silero_vad.h

namespace audionotes {

// spans:                 speech spans the VAD has RELEASED, in order.
// pending_span_start_ms: start of the earliest span the VAD knows about but has not released —
//                        one it is still inside, or one held back pending a merge — or -1.
// captured_ms:           how much audio exists on disk.
//
// The budget cannot certify finality (it depends on where the next span ENDS, which is unknown),
// so the merge gap is the only rule used. That is sufficient, and being conservative costs a
// little latency and never correctness.
std::vector<Chunk> finalChunks(const std::vector<Segment>& spans,
                               int64_t pending_span_start_ms,
                               int64_t captured_ms,
                               int64_t max_chunk_ms,
                               ChunkMode mode = ChunkMode::kPack,
                               int64_t max_gap_ms = kMaxMergeGapMs);

}  // namespace audionotes
