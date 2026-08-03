// On-device speaker diarization via sherpa-onnx (segmentation + speaker embedding + clustering).
// This is the category's weak spot; the manual Speakers screen is the guaranteed fallback.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace audionotes {

struct DiarSegment {
  int64_t start_ms;
  int64_t end_ms;
  int speaker;  // cluster index
};

class Diarizer {
 public:
  // num_speakers: 0 = auto (threshold clustering); >0 = fixed cluster count.
  Diarizer(const std::string& seg_model, const std::string& emb_model,
           int sample_rate, int num_speakers);
  ~Diarizer();

  bool ok() const;  // false if sherpa-onnx is not compiled in or models failed to load

  // pcm_path: 16 kHz mono PCM16. Returns segments sorted by start time.
  std::vector<DiarSegment> process(const std::string& pcm_path);

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace audionotes
