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

// Polled before each chunk; true = stop and return what has been transcribed so far. ASR is by
// far the longest stage (whisper-base runs ~0.68x realtime), so a between-stages-only check
// would leave a cancel unanswered for minutes.
using AsrCancelFn = std::function<bool()>;

class WhisperAsr {
 public:
  // language: a whisper language code ("en", "hi", ...) or "auto". With no_context set, "auto"
  // re-detects per 30 s chunk, so one meeting can come back in several languages AND several
  // scripts — a Hindi/English meeting produced Urdu script for 39% of its utterances.
  //
  // Defaults to "en": most first meetings are in English, and per-chunk re-detection is the bug
  // above rather than a feature. Any other language is pinned the same way — this layer never
  // asks an engine to emit one language for audio in another.
  explicit WhisperAsr(const std::string& model_path, const std::string& language = "en");
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
      const AsrProgressFn& progress = nullptr,
      const AsrCancelFn& cancel = nullptr);

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace audionotes
