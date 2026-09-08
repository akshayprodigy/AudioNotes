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
  //
  // Implemented as reset() + feed(the whole file) + finish(), so the live capture path and this
  // one are not merely equivalent — they are the same code. That is the only way the live pass
  // can key a cache on chunk boundaries and expect the finished recording to ask for them.
  std::vector<Segment> process(const std::string& pcm_path, const VadConfig& cfg = VadConfig());

  // ---- Streaming API, for transcribing while the recording is still being written ----

  // Start a new stream. Must be called before the first feed().
  void reset(const VadConfig& cfg = VadConfig());

  // Consume [from_byte, from_byte + byte_count) of a PCM16 mono file and return any spans
  // released. Bytes that do not complete a frame are retained for the next call, so feeding
  // [A][B] gives exactly what feeding [AB] gives.
  std::vector<Segment> feed(const std::string& pcm_path, int64_t from_byte, int64_t byte_count);

  // No more audio is coming: release the held span and any span still open.
  std::vector<Segment> finish();

  // Start (ms) of the earliest span known but not released, or -1. See VadSpanBuilder.
  int64_t pendingSpanStartMs() const;

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace audionotes
