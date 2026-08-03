// Streaming Silero VAD (voice activity detection) over the shared C++ core.
// MIT model weights (silero_vad.onnx, v4 signature: inputs input/sr/h/c, outputs output/hn/cn).
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace audionotes {

struct Segment {
  int64_t start_ms;
  int64_t end_ms;
};

struct VadConfig {
  float threshold = 0.5f;      // speech onset probability
  int min_speech_ms = 250;     // drop blips shorter than this
  int min_silence_ms = 100;    // gap before a segment is closed
  int speech_pad_ms = 30;      // pad each side so we don't clip words
  int window = 512;            // samples per inference frame at 16 kHz
};

class SileroVad {
 public:
  SileroVad(const std::string& model_path, int sample_rate);
  ~SileroVad();

  // Stream a PCM16 mono file frame by frame (never loads the whole file into RAM).
  // Returns merged, padded speech segments in milliseconds.
  std::vector<Segment> process(const std::string& pcm_path, const VadConfig& cfg = VadConfig());

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace audionotes
