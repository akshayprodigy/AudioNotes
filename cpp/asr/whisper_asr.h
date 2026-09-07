// On-device ASR over whisper.cpp. Transcribes only VAD speech spans, combined into ~30s chunks,
// and re-anchors whisper's per-chunk timestamps back onto the global meeting timeline.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

#include "asr/asr_engine.h"

namespace audionotes {

class WhisperAsr : public AsrEngine {
 public:
  // language: a whisper language code ("en", "hi", ...) or "auto". With no_context set, "auto"
  // re-detects per 30 s chunk, so one meeting can come back in several languages AND several
  // scripts — a Hindi/English meeting produced Urdu script for 39% of its utterances.
  //
  // Defaults to "en": most first meetings are in English, and per-chunk re-detection is the bug
  // above rather than a feature. Any other language is pinned the same way — this layer never
  // asks an engine to emit one language for audio in another.
  // `skip_language_refusal` overrules the refusal for this run only — see
  // AsrConfig::skip_language_refusal. Detection still runs, so the run can still report what it
  // heard; only the decision to stop is bypassed.
  explicit WhisperAsr(const std::string& model_path, const std::string& language = "en",
                      bool skip_language_refusal = false);
  ~WhisperAsr() override;

  bool ok() const override;  // false if whisper is not compiled in or the model failed to load

  const char* name() const override { return "whisper"; }

  // 30 s is whisper's own internal window; matching it means a chunk is one forward pass.
  int64_t maxChunkMs() const override { return 30000; }

  // whisper returns its own timestamped segments within a window, so packing costs no utterance
  // granularity — unlike an engine that returns one untimestamped result per window.
  ChunkMode chunkMode() const override { return ChunkMode::kPack; }

  // whisper covers ~99 languages; whisper_lang_id() rejects anything it does not know.
  bool supports(const std::string& language) const override;

  // pcm_path: 16 kHz mono PCM16. segments: VAD speech spans (ms). Returns utterances in ms.
  // `threads` <= 0 selects the automatic big.LITTLE-aware default (see cpu_topology.h).
  // Exposed so a benchmark can sweep it and so tiers can trade speed for battery later.
  //
  // No default arguments: they are resolved by STATIC type on a virtual, so the same call would
  // mean different things through AsrEngine& than through WhisperAsr&. Callers pass all six.
  // Decode ONE window and return its segments with CHUNK-RELATIVE timestamps.
  //
  // Public because the live capture path decodes the same windows ahead of time and must produce
  // byte-identical results; sharing this body is what guarantees that, rather than two call sites
  // that merely look alike. Returns empty on a decode failure or an unreadable range.
  // `failed` (optional) distinguishes the three ways this returns nothing: the window held no
  // audio, the decode FAILED, or the decode succeeded and every segment scrubbed to empty. Only
  // the middle one is a failure, and conflating them is what once let a silent room and a broken
  // decoder report the same thing — see AsrRun::allChunksFailed.
  std::vector<Utterance> decodeWindow(const std::string& pcm_path, int sample_rate,
                                      int64_t start_ms, int64_t end_ms, int threads,
                                      bool* failed) override;

  // Hand this run the windows the live capture pass already decoded. See AsrConfig::chunk_cache.
  void setChunkCache(std::vector<AsrCachedWindow> cache);

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
