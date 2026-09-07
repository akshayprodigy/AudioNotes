// On-device speaker diarization via sherpa-onnx (segmentation + speaker embedding + clustering).
// This is the category's weak spot; the manual Speakers screen is the guaranteed fallback.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

#include "diar/speaker_match.h"

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
  //
  // speaker_match_threshold: how close two WINDOWS' speakers must be to be called one person.
  // A different quantity from `threshold` above and measured separately — see
  // diar/speaker_match.h. Only consulted when a meeting needs more than one window.
  Diarizer(const std::string& seg_model, const std::string& emb_model,
           int sample_rate, int num_speakers, float threshold = 1.0f,
           float speaker_match_threshold = kSpeakerMergeThreshold);
  ~Diarizer();

  bool ok() const;  // false if sherpa-onnx is not compiled in or models failed to load

  // pcm_path: 16 kHz mono PCM16. Returns segments sorted by start time.
  //
  // The whole-file overload reads every second of the recording, silence included, into one
  // buffer whose size follows the meeting: 346 MB of float samples for 90 minutes before sherpa's
  // own copies, measured on a Pixel 7 Pro as still running after 47 minutes at 2.55 GB. It is
  // kept only for a caller that has not run VAD and therefore cannot say where the speech is.
  // Prefer a span overload, which in this app is always possible.
  std::vector<DiarSegment> process(const std::string& pcm_path);

  // Diarize only the given speech spans, joined end to end, and return segments on the
  // recording's own timeline. Segments straddling a join are split — see diar/span_map.h.
  std::vector<DiarSegment> process(const std::string& pcm_path, const std::vector<struct Span>& spans);

  // As above, but says how much speech may be in flight at once.
  //
  // Windowing WOULD make the cost independent of the meeting's length: each window is read,
  // diarized and freed before the next is touched, and the windows' separate speaker numberings
  // are then reconciled by matching voices across them (diar/speaker_match.h). It is off by
  // default because that reconciliation costs 6 DER points — see kDiarWindowMs in
  // diar/span_map.h for the measurements and for what handles the memory instead.
  //
  //   window_ms > 0   diarize this much speech at a time
  //   window_ms == 0  the shipped default, kDiarWindowMs, which is itself 0 — so, no windowing
  //   window_ms < 0   no windowing: one buffer for all the speech there is
  //
  // Ignored when num_speakers is fixed: a cluster count is a statement about the whole recording
  // and a window cannot honour it.
  std::vector<DiarSegment> process(const std::string& pcm_path, const std::vector<struct Span>& spans,
                                   int64_t window_ms);

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace audionotes
