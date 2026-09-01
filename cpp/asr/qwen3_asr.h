// Qwen3-ASR over sherpa-onnx's offline recognizer.
//
// Exists because whisper cannot hear Hindi: on the 2026-08-19 recording whisper-base produced 891
// words at 8.8% Devanagari with 21.1% Urdu-script junk, and this produced 1,211 words at 87.6%
// with 1.0%.
//
// TWO THINGS THAT SHAPE THIS CLASS:
//
// 1. It returns ONE UNTIMESTAMPED result per window. whisper returns several timestamped segments
//    per window; this never fills result.timestamps. Since speakers are assigned per utterance
//    (see alignSpeakers), packing 30 s of audio into one window would hand everything said in it
//    a single speaker label. Hence ChunkMode::kPerSpan.
// 2. Its decoder has a fixed token budget (max_total_len, 512 by default) and SILENTLY TRUNCATES
//    audio that exceeds it — roughly 38 s. maxChunkMs() stays well inside that.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

#include "asr/asr_engine.h"

namespace audionotes {

class Qwen3Asr : public AsrEngine {
 public:
  // model_dir contains conv_frontend.onnx, encoder.onnx, decoder.onnx and tokenizer/.
  //
  // Resolved by convention from one directory rather than four separate paths, so that AsrConfig,
  // the CLI, the JNI and the eval harness all keep passing a single string — and so the model
  // catalogue later gains one directory-shaped entry instead of four file-shaped ones.
  explicit Qwen3Asr(const std::string& model_dir, const std::string& language = "en");
  ~Qwen3Asr() override;

  bool ok() const override;
  const char* name() const override { return "qwen3"; }

  // Well inside the ~38 s the 512-token budget allows: the budget is consumed by the prompt and
  // any hotwords too, and running near a silent-truncation cliff is not worth the speed.
  int64_t maxChunkMs() const override { return 25000; }

  // One result per window and no timestamps, so the window must be the turn. See the header note.
  ChunkMode chunkMode() const override { return ChunkMode::kPerSpan; }

  bool supports(const std::string& language) const override;

  // `threads` is accepted for interface parity but CANNOT be honoured per call: ONNX Runtime
  // fixes intra-op thread count when the session is created, which happens in the constructor.
  // Said plainly here rather than silently ignored.
  AsrRun transcribe(const std::string& pcm_path,
                    const std::vector<Segment>& segments,
                    int sample_rate,
                    int threads,
                    const AsrProgressFn& progress,
                    const AsrCancelFn& cancel) override;

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace audionotes
