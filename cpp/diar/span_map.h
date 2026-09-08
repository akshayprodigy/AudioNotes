// Translating diarization between concatenated-speech time and the real recording, and cutting
// that recording into windows small enough to diarize.
//
// Diarization is run over the VAD speech spans joined end to end rather than over the whole
// recording. That was built as the fix for memory, and it is NOT one: measured with
// eval/speech_fraction.py, padded speech covers 62-87% of an AMI meeting, so skipping the silence
// saves 13-38%. A constant factor on a cost that still grows with the meeting — a long enough
// recording fails exactly as it did before, just later. What the spans did buy is accuracy
// (mean DER 20.4 -> 20.0, attribution 87.2 -> 88.4), and that is the reason to keep them.
//
// windowSpans() below WOULD bound the memory — diarize a fixed amount of speech at a time and the
// peak stops depending on how long the meeting was. It is off by default because it costs 6 DER
// points and 7 points of attribution to reconcile speakers across the windows; see kDiarWindowMs.
// The memory is handled by refusing the meeting instead, on the Kotlin side, in DiarBudget.
//
// For scale: on a Pixel 7 Pro, diarizing a 90-minute meeting whole reads a 346 MB float vector
// before sherpa makes its own copies, and was measured at 2.55 GB of peak PSS.
//
// The cost of both choices is this file: results come back on a timeline that does not exist, and
// have to be put back on the one the user sees. Kept free of sherpa and ONNX so it compiles and
// tests on its own — the arithmetic is where the risk is, not the model.
#pragma once
#include <cstdint>
#include <vector>

#include "diar/diarizer.h"

namespace audionotes {

/** A span of speech on the real recording's timeline, in milliseconds. */
struct Span {
  int64_t start_ms;
  int64_t end_ms;
};

/**
 * Grow each span by `pad_ms` on both sides, clamp to the recording, and merge what now overlaps.
 *
 * Diarizing bare VAD spans measurably hurt attribution, and the mechanism is not subtle: joining
 * two speakers' turns with no gap between them presents pyannote's segmentation with a speaker
 * change that never happened, and removes the silence it was reading as a boundary. Measured on
 * AMI ES2003a — the fixture with the longest turns and the most silence to lose — DER went
 * 16.4% to 24.1% and attribution 95.8% to 84.7%.
 *
 * Keeping a margin of REAL silence either side restores that context while still skipping the
 * long gaps. Merging is not optional: two overlapping padded spans would copy the overlapping
 * audio into the buffer twice, and every timestamp after it would be wrong.
 */
std::vector<Span> padAndMerge(const std::vector<Span>& spans, int64_t pad_ms, int64_t total_ms);

/**
 * How much real silence to keep either side of each speech span.
 *
 * One constant because it is the dial this trade runs on. It is NOT a memory-versus-accuracy dial,
 * which is how it was first described: at 500 ms the padded spans already cover most of the
 * recording, so growing it further changes accuracy and barely touches the buffer. Swept against
 * AMI with eval/run.py. 500 recovered the attribution that bare spans lost; 1000 was tried and
 * was worse where it mattered most — ES2003a attribution 91.0% -> 87.3% — so this is a peak and
 * not a direction.
 */
constexpr int64_t kDiarPadMs = 500;

/** Where each span begins once the spans are laid end to end. */
std::vector<int64_t> concatOffsets(const std::vector<Span>& spans);

/** How much speech there is, which is how long the concatenated buffer will be. */
int64_t totalSpeechMs(const std::vector<Span>& spans);

/**
 * How much speech to diarize at once — and the shipped answer is ALL of it.
 *
 * Windowing was built to bound the memory, measured against AMI, and shelved. It works, in the
 * sense that the peak stops following the meeting's length. It costs too much to use:
 *
 *              DER              attribution
 *   whole      20.0             88.4          <- shipped
 *   windowed   26.2 - 27.7      81.5 - 84.1   <- two rounds of trying
 *
 * The cost is structural, not a tuning miss. Each window is clustered on its own, so the windows
 * have to work out afterwards which of their speakers were the same people — from one averaged
 * voice per speaker per window, where sherpa had every per-segment embedding. Two rounds of fixes
 * (average linkage for one failure, a cannot-link constraint within a window for the opposite one)
 * moved it a point and never closed the gap. A speaker label that is confidently wrong is worse
 * than a slow one, and this product puts those labels in documents people forward.
 *
 * The memory problem is handled instead by DiarBudget on the Kotlin side, which asks whether the
 * whole meeting fits and skips diarization outright when it does not — visible, explained, and
 * recoverable, where an OOM kill takes the meeting with it.
 *
 * 0 therefore means "no windowing". The machinery below stays, reachable through
 * --diar-window-min, because the numbers above are worth being able to reproduce and because the
 * honest next attempt is per-segment embeddings clustered globally, which starts from this code.
 */
constexpr int64_t kDiarWindowMs = 0;  // 0 = diarize the whole meeting in one pass

/**
 * Cut the padded spans into windows holding at most `window_ms` of speech each.
 *
 * This is what makes the peak independent of the meeting's length: one window's audio is read,
 * diarized and freed before the next is touched. Windows are filled greedily and a span is never
 * split just to top one up — a window that comes in under budget costs nothing, while a cut costs
 * segmentation the context either side of it.
 *
 * A span LONGER than a whole window is cut, because it has to be: an hour of continuous speech
 * with no VAD gap (a lecture, or a room too noisy for the detector to drop out) would otherwise
 * put the bound straight back. AMI never reaches this — the longest padded span across the four
 * fixtures is 229 s — but the case that breaks the bound is exactly the case nobody tests.
 *
 * A cut is a real boundary in the audio and segmentation will read it as a speaker change. That
 * is not fixed here; it is repaired afterwards by matching the speakers either side of it on their
 * voices, which is why the windows carry embeddings at all. See diar/speaker_match.h.
 *
 * `window_ms <= 0` returns every span in a single window, which is the un-windowed behaviour.
 */
std::vector<std::vector<Span>> windowSpans(const std::vector<Span>& spans, int64_t window_ms);

/**
 * Put diarization results back on the real timeline.
 *
 * A segment that straddles a join is SPLIT rather than stretched. In concatenated time the two
 * halves are adjacent; in the recording they can be minutes apart, and emitting one segment
 * across the gap would attribute every silence — and anyone who spoke during it — to whoever
 * happened to be talking either side.
 *
 * Returns segments sorted by real start time. Input need not be sorted.
 */
std::vector<DiarSegment> toOriginalTimeline(const std::vector<DiarSegment>& concat,
                                            const std::vector<Span>& spans);

}  // namespace audionotes
