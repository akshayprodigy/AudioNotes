// How VAD speech spans become the windows an ASR engine decodes.
//
// Lifted out of whisper_asr.cpp unchanged. It lives here because two engines now need it and
// because their numbers are only comparable if they see identical boundaries — a WER gap that is
// really a chunking artefact would be worse than no measurement at all.
#pragma once
#include <cstdint>
#include <vector>

#include "vad/silero_vad.h"  // Segment

namespace audionotes {

struct Chunk {
  int64_t start_ms;
  int64_t end_ms;
};

// How an engine wants its audio sliced.
enum class ChunkMode {
  // Pack spans together up to the budget. Fewer, larger windows: fewer decoder invocations, and
  // fine for an engine that returns its own timestamps within a window.
  kPack,
  // One VAD span per chunk. For an engine that returns ONE untimestamped result per window, the
  // window IS the utterance — so packing would hand a single speaker label to everything said in
  // 30 seconds. Costs more invocations and buys turn-shaped utterances.
  kPerSpan,
};

// Combine VAD spans into decode windows. No window exceeds `max_chunk_ms`, and consecutive
// windows are contiguous, so no audio is dropped between them.
//
// The budget is a hard guarantee and not a hint, because it used to be one: a single span longer
// than the budget once became a window of its full length, which whisper survived by re-windowing
// internally and a token-budgeted engine would have silently truncated.
//
// Windows do NOT overlap. Overlap would need per-engine de-duplication — whisper returns
// timestamps you could dedupe against, while an engine returning one untimestamped result per
// window would duplicate whole utterances — and there is no fixture demonstrating boundary word
// loss to tune it against. Duplicated or deleted speech is a worse failure than a clipped word.
std::vector<Chunk> makeChunks(const std::vector<Segment>& segs, int64_t max_chunk_ms,
                              ChunkMode mode = ChunkMode::kPack);

}  // namespace audionotes
