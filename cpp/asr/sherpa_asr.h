// The two English candidates measured against whisper-base, both driven by the sherpa-onnx
// offline recognizer that is already vendored and already linked for Qwen3-ASR and diarization.
//
// They share one class because they differ in exactly one thing — which member of
// SherpaOnnxOfflineModelConfig gets the file paths. Everything after that (chunking, decoding,
// cancellation, post-processing) is identical, and three copies of that loop is three places for
// a comparison to stop being fair.
//
// **Why these two.** English is the whole product now, so its error rate is the product's error
// rate. whisper-base measures WER 29.7% on AMI (docs/superpowers/eval-baseline-whisper-base.md);
// Parakeet-TDT publishes roughly 16% on this same runtime. If that holds it halves the error rate
// of everything being sold, which is worth knowing before the store listing rather than after.
#pragma once
#include <string>

#include "asr/asr_engine.h"

namespace audionotes {

class SherpaAsr : public AsrEngine {
 public:
  // Which set of weights, and therefore which config member is filled in.
  enum class Flavour {
    // NVIDIA Parakeet-TDT 0.6B v2, exported as a non-streaming NeMo transducer:
    // encoder/decoder/joiner + tokens.txt.
    kParakeet,
    // Moonshine base (English), exported as preprocess/encode/uncached_decode/cached_decode +
    // tokens.txt.
    kMoonshine,
  };

  SherpaAsr(Flavour flavour, const std::string& model_dir, const std::string& language);
  ~SherpaAsr() override;

  bool ok() const override;
  const char* name() const override;
  std::string unavailableReason() const override;

  // Deliberately whisper's numbers, not each model's own comfortable window.
  //
  // asr_chunker.h states the rule these exist to obey: two engines' numbers are only comparable
  // if they see identical boundaries, because a WER gap that is really a chunking artefact is
  // worse than no measurement at all. Whatever these models could do with a longer window is a
  // separate question from whether they read the same audio better than whisper does, and only
  // the second one is being asked here.
  int64_t maxChunkMs() const override { return 30000; }
  ChunkMode chunkMode() const override { return ChunkMode::kPack; }

  // Both exports are English-only. "auto" is accepted because the pipeline passes it when nobody
  // has chosen, and English is what it resolves to.
  bool supports(const std::string& language) const override;

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
