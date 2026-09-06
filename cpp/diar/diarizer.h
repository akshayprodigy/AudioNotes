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
  // threshold: only consulted when num_speakers is 0. Distance below which two clusters merge,
  // so a SMALLER value splits more. sherpa's default of 0.5 is wrong for CAM++ on meeting audio
  // and was measured splitting 4-speaker meetings into 28-101 clusters; 1.0 is the peak of a
  // sweep over four AMI meetings, two of them held out (DER 46.2%->15.9%, 33.3%->8.5%,
  // 71.9%->30.9%). It IS a peak — 1.2 over-merges and lands worse than 0.5.
  // See docs/superpowers/eval-baseline-whisper-base.md.
  Diarizer(const std::string& seg_model, const std::string& emb_model,
           int sample_rate, int num_speakers, float threshold = 1.0f);
  ~Diarizer();

  bool ok() const;  // false if sherpa-onnx is not compiled in or models failed to load

  // pcm_path: 16 kHz mono PCM16. Returns segments sorted by start time.
  //
  // The whole-file overload reads every second of the recording, silence included. That is what
  // made a 90-minute meeting undiarizable on a phone: 346 MB of float samples before sherpa's own
  // copies, still running after 47 minutes at 2.55 GB. Prefer the span overload wherever VAD has
  // already run, which in this app is everywhere.
  std::vector<DiarSegment> process(const std::string& pcm_path);

  // Diarize only the given speech spans, joined end to end, and return segments on the
  // recording's own timeline. Segments straddling a join are split — see diar/span_map.h.
  std::vector<DiarSegment> process(const std::string& pcm_path, const std::vector<struct Span>& spans);

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace audionotes
