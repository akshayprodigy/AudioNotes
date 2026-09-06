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
