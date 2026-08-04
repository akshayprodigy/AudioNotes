// On-device ASR over whisper.cpp. Transcribes only VAD speech spans, combined into ~30s chunks,
// and re-anchors whisper's per-chunk timestamps back onto the global meeting timeline.
#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "vad/silero_vad.h"  // reuse Segment

namespace audionotes {

struct Utterance {
  int64_t start_ms;
  int64_t end_ms;
  std::string text;
};

// progress(done_chunks, total_chunks)
using AsrProgressFn = std::function<void(int, int)>;

class WhisperAsr {
 public:
  explicit WhisperAsr(const std::string& model_path);
  ~WhisperAsr();

  bool ok() const;  // false if whisper is not compiled in or the model failed to load

  // pcm_path: 16 kHz mono PCM16. segments: VAD speech spans (ms). Returns utterances in ms.
  // `threads` <= 0 selects the automatic big.LITTLE-aware default (see asrThreadCount).
  // Exposed so a benchmark can sweep it and so tiers can trade speed for battery later.
  std::vector<Utterance> transcribe(
      const std::string& pcm_path,
      const std::vector<Segment>& segments,
      int sample_rate,
      int threads = 0,
      const AsrProgressFn& progress = nullptr);

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace audionotes
