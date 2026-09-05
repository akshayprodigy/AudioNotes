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

//: The most silence a decode window may swallow between two speech spans, before we start a new
//: window instead.
//:
//: Packing used to test only the window's total length, never the gap. So a 0.4 s creak in a quiet
//: room was merged with real speech 24 seconds later, and whisper -- handed a window that is almost
//: entirely silence -- filled the silence in. Measured on eval/silence.py, 60 s of room tone before
//: a real meeting: 43 invented words describing a meeting that never happened, in a minute where
//: nobody spoke. Its worst window swallowed 27 seconds of silence.
//:
//: The value is measured, and the measurement is two-sided: every threshold below removes the
//: invention, so the number is chosen on what it COSTS in real words, not on what it fixes.
//:
//:   gap     invented   ES2002a WER (del)     ES2003a WER (del)
//:   none        43     29.78% (302)          24.86% (224)
//:   3000 ms      0     30.95% (335)          25.75% (233)
//:   5000 ms      0       --                  25.51% (232)
//:   8000 ms      0     30.64% (338)          24.96% (225)
//:   12000 ms     0     29.70% (304)          24.86% (224)
//:
//: 12 s is the loosest tested, and the only one that costs nothing: tighter thresholds split
//: windows that legitimately span a pause, and every extra boundary is a window decoded without
//: the context of the one before it (no_context is set), which shows up as DELETED words. 8 s
//: looked like a safer margin against gaps this corpus does not contain -- and cost 36 real words
//: on ES2002a to buy it. A hypothesis about unseen failures does not outrank a measured loss.
constexpr int64_t kMaxMergeGapMs = 12000;

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
                              ChunkMode mode = ChunkMode::kPack,
                              int64_t max_gap_ms = kMaxMergeGapMs);

}  // namespace audionotes
