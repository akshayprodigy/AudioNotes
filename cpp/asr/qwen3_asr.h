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
// 2. Its decoder has TWO budgets and silently truncates against either: max_total_len (512)
//    covers prompt plus audio, and max_new_tokens (128) caps the text it may emit. The second is
//    the one that bites — see maxChunkMs().
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

  // MEASURED, on the 2026-08-19 Hindi recording. An earlier version of this file said 25 s was
  // "well inside the ~38 s the 512-token budget allows" — which named the wrong cliff. The binding
  // limit is max_new_tokens (128) on the OUTPUT, not the audio length, and 25 s of speech produces
  // more text than 128 tokens can hold. It truncated mid-word and lost half the transcript:
  //
  //     windows   words   Devanagari   CJK     median utterance
  //     25 s       692      53.7%      0.0%       23.3 s   <- truncating; 1 word from one window
  //     10 s     1,205      69.8%      0.8%        8.5 s   <- this
  //     per-span 1,338      59.6%     11.1%        1.5 s   <- see below
  int64_t maxChunkMs() const override { return 10000; }

  // ALSO MEASURED, and the opposite of what the first version of this file assumed.
  //
  // The reasoning for kPerSpan was sound and the result was still wrong. This model returns one
  // untimestamped result per window, so packing costs utterance granularity and blurs speaker
  // assignment — all true. But a VAD span is a median 1.5 s, and handed a sub-second backchannel
  // this model answers in ITS home language: 33 of the 34 Chinese and Korean utterances in the
  // per-span run were under two seconds, a median of 0.64 s against 2.08 s for everything else.
  // "嗯" is Mandarin for "hmm".
  //
  // Packing to 10 s is what actually fixes the language leak — 11.1% CJK down to 0.8% — because
  // context, not the language hint alone, is what keeps the decoder in the right language. The
  // granularity cost is real and accepted: 8.5 s utterances instead of 1.5 s.
  ChunkMode chunkMode() const override { return ChunkMode::kPack; }

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
