// Translating diarization between concatenated-speech time and the real recording.
//
// Diarization is run over the VAD speech spans joined end to end rather than over the whole
// recording, for the same reason ASR always has been: the silence cannot be attributed to anybody,
// and paying for it is expensive. Measured on a Pixel 7 Pro, whole-recording diarization of a
// 90-minute meeting was still running after 47 minutes at 2.55 GB, having read the entire file
// into a 346 MB float vector before sherpa made its own copies.
//
// The cost of that choice is this file: results come back on a timeline that does not exist, and
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
 * long gaps, which is where the memory actually goes. Merging is not optional: two overlapping
 * padded spans would copy the overlapping audio into the buffer twice, and every timestamp after
 * it would be wrong.
 */
std::vector<Span> padAndMerge(const std::vector<Span>& spans, int64_t pad_ms, int64_t total_ms);

/**
 * How much real silence to keep either side of each speech span.
 *
 * One constant because it is the dial this trade runs on: larger keeps more of the context
 * segmentation wants and less of the memory saving. Swept against AMI with eval/run.py — the
 * value here is the one that recovered ES2003a without giving the win back.
 */
constexpr int64_t kDiarPadMs = 1000;  // SWEEP EXPERIMENT — revert if not better

/** Where each span begins once the spans are laid end to end. */
std::vector<int64_t> concatOffsets(const std::vector<Span>& spans);

/** How much speech there is, which is how long the concatenated buffer will be. */
int64_t totalSpeechMs(const std::vector<Span>& spans);

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
