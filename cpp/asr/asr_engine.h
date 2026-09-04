// The shape every ASR engine presents to the rest of the core.
//
// Utterance lives here rather than in whisper's header because two engines now return it, and a
// type owned by one implementation is a type the next implementation has to include a competitor
// to use.
#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "asr/asr_chunker.h"  // ChunkMode, and Segment via vad/silero_vad.h

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

// What a run produced AND what happened during it. The second half is not bookkeeping: a
// transcribe() that returned a bare vector could not distinguish "the room was silent" from
// "every chunk failed to decode", and the pipeline reported both as "no speech detected".
struct AsrRun {
  std::vector<Utterance> utterances;
  int chunks_total = 0;
  int chunks_failed = 0;
  bool cancelled = false;

  // Provenance. Recorded so a user reporting a garbled meeting can be answered with what actually
  // ran, rather than with what we assume runs.
  std::string engine;             // "whisper" | "qwen3"
  std::string model_path;
  std::string language;           // what was requested
  std::string detected_language;  // what the engine reported, where it can; "" otherwise
  float detected_confidence = 0.f;  // 0..1 for detected_language; 0 when nothing was detected

  // Set when the audio was confidently in a language this product does not transcribe, in which
  // case the run STOPS rather than producing text. Fluent invented English over Bengali audio,
  // summarised into plausible minutes, is the failure this exists to prevent — see
  // docs/superpowers/specs/2026-09-04-english-only-and-refusing-to-fabricate-design.md.
  bool unsupported_language = false;

  // The state that must never again be reported as silence.
  bool allChunksFailed() const { return chunks_total > 0 && chunks_failed == chunks_total; }
};

class AsrEngine {
 public:
  virtual ~AsrEngine() = default;

  // False when the engine is not compiled in or its weights failed to load. Construction always
  // succeeds — sherpa segfaults rather than returning an error, so loading is guarded, not caught.
  virtual bool ok() const = 0;

  virtual const char* name() const = 0;

  // Why ok() is false, when the engine can say. Empty otherwise. Not pure: most engines have
  // nothing to add beyond "the weights did not load", and a caller naming the wrong model file
  // sends whoever reads the log hunting the wrong problem.
  virtual std::string unavailableReason() const { return std::string(); }
  virtual int64_t maxChunkMs() const = 0;
  virtual ChunkMode chunkMode() const = 0;
  virtual bool supports(const std::string& language) const = 0;

  // pcm_path: 16 kHz mono PCM16. segments: VAD speech spans (ms).
  // `threads` <= 0 selects the big.LITTLE-aware default (see util/cpu_topology.h).
  virtual AsrRun transcribe(const std::string& pcm_path,
                            const std::vector<Segment>& segments,
                            int sample_rate,
                            int threads,
                            const AsrProgressFn& progress,
                            const AsrCancelFn& cancel) = 0;
};

// A path PER ENGINE, not one shared model_path: the factory routes by language, so it must be
// able to reach either engine's weights without the caller having already guessed which engine
// its language was going to select.
struct AsrConfig {
  std::string engine;           // "" = choose by policy; "whisper"/"qwen3" forces one
  std::string language = "en";
  std::string whisper_model;    // a file
  std::string qwen3_model_dir;  // a directory; "" when not installed
};

// The one place a language becomes a class. Never returns null: when nothing usable is available
// it returns an engine whose ok() is false, carrying the reason, so callers have one failure
// path rather than two.
std::unique_ptr<AsrEngine> makeAsrEngine(const AsrConfig& cfg);

}  // namespace audionotes
