#include "vad/vad_span_builder.h"

#include <algorithm>

namespace audionotes {

VadSpanBuilder::VadSpanBuilder(const VadConfig& cfg, int sample_rate)
    : cfg_(cfg),
      sample_rate_(sample_rate),
      min_speech_(static_cast<int64_t>(cfg.min_speech_ms) * sample_rate / 1000),
      min_silence_(static_cast<int64_t>(cfg.min_silence_ms) * sample_rate / 1000),
      pad_(static_cast<int64_t>(cfg.speech_pad_ms) * sample_rate / 1000) {}

// Pad, convert to ms, and merge with whatever is held. Returns what can now be released.
std::vector<Segment> VadSpanBuilder::release(int64_t start_sample, int64_t end_sample) {
  const int64_t s = std::max<int64_t>(0, start_sample - pad_);
  const int64_t e = end_sample + pad_;
  const Segment next{s * 1000 / sample_rate_, e * 1000 / sample_rate_};

  std::vector<Segment> out;
  if (has_held_ && next.start_ms <= held_.end_ms) {
    held_.end_ms = std::max(held_.end_ms, next.end_ms);  // overlap after padding: one span
    return out;
  }
  if (has_held_) out.push_back(held_);
  held_ = next;
  has_held_ = true;
  return out;
}

std::vector<Segment> VadSpanBuilder::push(float prob, int64_t frame_start) {
  const float neg_threshold = cfg_.threshold - 0.15f;
  cursor_ = frame_start + cfg_.window;

  std::vector<Segment> out;
  if (prob >= cfg_.threshold && temp_end_ != 0) temp_end_ = 0;
  if (prob >= cfg_.threshold && !triggered_) {
    triggered_ = true;
    speech_start_ = frame_start;
  } else if (prob < neg_threshold && triggered_) {
    if (temp_end_ == 0) temp_end_ = frame_start;
    if (cursor_ - temp_end_ >= min_silence_) {
      if (temp_end_ - speech_start_ > min_speech_) out = release(speech_start_, temp_end_);
      triggered_ = false;
      temp_end_ = 0;
    }
  }
  return out;
}

std::vector<Segment> VadSpanBuilder::finish(int64_t end_sample) {
  std::vector<Segment> out;
  if (triggered_ && end_sample - speech_start_ > min_speech_) {
    out = release(speech_start_, end_sample);
    triggered_ = false;
  }
  if (has_held_) {
    // The file path clamps a span's padded end to the length of the audio.
    held_.end_ms = std::min(held_.end_ms, end_sample * 1000 / sample_rate_);
    out.push_back(held_);
    has_held_ = false;
  }
  return out;
}

int64_t VadSpanBuilder::pendingSpanStartMs() const {
  if (has_held_) return held_.start_ms;
  if (triggered_) {
    return std::max<int64_t>(0, speech_start_ - pad_) * 1000 / sample_rate_;
  }
  return -1;
}

}  // namespace audionotes
