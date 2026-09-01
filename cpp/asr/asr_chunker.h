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

// Combine VAD spans into decode windows.
//
// KNOWN DEFECT, PINNED DELIBERATELY (fixed in a later commit, with its own test diff): in kPack
// mode a single span longer than `max_chunk_ms` becomes one chunk of its FULL length, because the
// budget is only consulted when deciding whether to append another span. whisper survives this by
// re-windowing internally; an engine with a fixed token budget silently truncates instead.
std::vector<Chunk> makeChunks(const std::vector<Segment>& segs, int64_t max_chunk_ms,
                              ChunkMode mode = ChunkMode::kPack);

}  // namespace audionotes
