// Silero's output is a speech probability per frame. Turning that stream into padded, merged
// speech spans is a small state machine, and it is the part that has to behave identically
// whether the audio arrives from a finished file or from a capture still in progress.
//
// It lives here rather than inside silero_vad.cpp so it can be tested with synthetic
// probabilities and no model at all — the same reason asr_chunker was lifted out of whisper_asr.
#pragma once
#include <cstdint>
#include <vector>

#include "vad/silero_vad.h"  // Segment, VadConfig

namespace audionotes {

class VadSpanBuilder {
 public:
  VadSpanBuilder(const VadConfig& cfg, int sample_rate);

  // Feed one frame's speech probability. `frame_start` is the index of the frame's first sample.
  // Returns any spans RELEASED by this frame — usually none.
  //
  // A closed span is held back until the following span is known, because padding can make two
  // spans overlap and the file path merges them. Holding is what keeps the two paths identical.
  std::vector<Segment> push(float prob, int64_t frame_start);

  // End of audio: release the held span and any span still open. `end_sample` is the total
  // number of samples seen, which is what a still-open span is clamped to.
  std::vector<Segment> finish(int64_t end_sample);

  // Start (ms) of the earliest span this builder knows about but has NOT released — one still in
  // progress, or one closed and held pending a merge. -1 when there is none.
  //
  // The live chunker needs exactly this: both kinds are invisible to the caller and both can
  // still be packed into the previous decode window.
  int64_t pendingSpanStartMs() const;

 private:
  VadConfig cfg_;
  int sample_rate_;
  int64_t min_speech_, min_silence_, pad_;

  bool triggered_ = false;
  int64_t temp_end_ = 0;
  int64_t speech_start_ = 0;
  int64_t cursor_ = 0;  // first sample AFTER the most recent frame

  bool has_held_ = false;
  Segment held_{0, 0};

  std::vector<Segment> release(int64_t start_sample, int64_t end_sample);
};

}  // namespace audionotes
