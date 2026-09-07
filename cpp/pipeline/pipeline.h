// The shared brain: PCM in -> transcript + speakers + minutes out. Capture-agnostic — every
// platform shell (desktop CLI today; Android JNI / iOS / Windows next) drives this same class, so
// the pipeline behaves identically everywhere. DB writes, retitling, retention and status
// bookkeeping are deliberately NOT here — they are app concerns (see ProcessingEngine.kt).
#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "asr/asr_engine.h"             // Utterance {start_ms,end_ms,text}
#include "diar/diarizer.h"              // DiarSegment
#include "minutes/minutes_extractor.h"  // DraftMinute, MinuteUtt, MinuteSpk
#include "vad/silero_vad.h"             // Segment

namespace audionotes {

struct AlignedUtterance {
  int64_t start_ms;
  int64_t end_ms;
  int speaker;  // diar cluster index; -1 = unassigned
  std::string text;
};

struct PipelineConfig {
  std::string asr_model;       // required: the whisper weights file
  std::string qwen3_model_dir; // "" = Qwen3-ASR not installed; a DIRECTORY when it is
  // A sherpa-onnx export of Parakeet-TDT or Moonshine. Measurement-only today: neither is
  // reachable unless asr_engine names it, because no language routes there yet.
  std::string sherpa_model_dir;
  // Overrule the language refusal for this run. See AsrConfig::skip_language_refusal.
  bool skip_language_refusal = false;
  std::string asr_engine;      // "" = choose by language; a name forces one (see asr_factory)
  std::string vad_model;       // "" = skip VAD, fall back to fixed 30 s windows
  std::string diar_seg_model;  // both diar paths "" = skip diarization
  std::string diar_emb_model;
  std::string llm_model;       // "" = rule-based minutes only
  std::string language = "en";  // a language code; "auto" re-detects per chunk (the bug, not the default)
  int num_speakers = 0;        // 0 = auto clustering
  float diar_threshold = 1.0f; // auto-clustering merge distance; smaller splits more
  // How much speech to diarize at once, which is what bounds the memory. 0 = the shipped default
  // (diar/span_map.h kDiarWindowMs), negative = one buffer for the whole recording. Negative is
  // how the before-and-after comparison is run and is not a configuration anybody should ship.
  int64_t diar_window_ms = 0;
  // How close two windows' speakers must be to be called one person. Only consulted for a meeting
  // long enough to need more than one window. 0 = the shipped default (kSpeakerMergeThreshold).
  float diar_speaker_threshold = 0.0f;
  int sample_rate = 16000;
  int asr_threads = 0;         // 0 = engine default
  int llm_threads = 4;
  int llm_n_ctx = 8192;        // mirrors LlmModule.kt
};

// progress(stage, done, total); stage in: "vad" | "asr" | "diarize" | "minutes"
// (the same stage names ProcessingEngine.Listener.onStage emits on Android).
using PipelineProgressFn = std::function<void(const std::string&, int, int)>;

// Polled between stages and between ASR chunks; true = stop. Mirrors the @Volatile cancelled
// flag ProcessingEngine checks on Android, so a user-cancelled meeting stops promptly instead
// of running a multi-minute transcription to completion.
using PipelineCancelFn = std::function<bool()>;

struct PipelineResult {
  int64_t audio_ms = 0;
  std::vector<Segment> segments;             // VAD speech spans
  std::vector<AlignedUtterance> transcript;  // ASR + speaker alignment
  std::vector<DraftMinute> minutes;          // summary/decisions/actions/questions
  std::string minutes_source;                // "llm" | "rule" | "" (no transcript)
  // Stopped early at the caller's request. Distinct from failure: whatever completed before the
  // cancel is still in this result, and callers must NOT treat it as a finished meeting.
  bool cancelled = false;

  // What the recording actually sounded like, and whether we refused it.
  //
  // `unsupported_language` means the audio was confidently in a language this build does not
  // transcribe, so ASR stopped after one window and NOTHING downstream ran — no transcript, no
  // minutes, and above all no narration. Plausible minutes written over a language we cannot read
  // is the failure this flag exists to make impossible; the audio is kept so the meeting can be
  // reprocessed when the language is supported.
  std::string detected_language;
  float detected_confidence = 0.f;
  bool unsupported_language = false;
  // Per-stage wall-clock ms (same rationale as ProcessingEngine's stageDone logging).
  int64_t vad_ms = 0, asr_ms = 0, diar_ms = 0, minutes_ms = 0;
};

// Pure function, exposed for tests: max-summed-overlap speaker assignment.
// Port of AudioDb.assignSpeakers (AudioDb.kt:245-286): per utterance, sum the temporal overlap
// with each cluster's diar segments; the cluster with the greatest sum wins; no overlap -> -1.
std::vector<AlignedUtterance> alignSpeakers(const std::vector<Utterance>& utts,
                                            const std::vector<DiarSegment>& diar);

// Cluster -> "Speaker N" display names, numbered 1..K over the clusters that actually own
// utterances, ascending cluster index (parity with AudioDb's create-then-drop-empty-then-renumber).
std::vector<MinuteSpk> speakerNames(const std::vector<AlignedUtterance>& transcript);

class Pipeline {
 public:
  explicit Pipeline(PipelineConfig cfg) : cfg_(std::move(cfg)) {}

  // Runs vad -> asr -> diarize -> align -> minutes over a headerless PCM16 mono file.
  // Returns false only on fatal setup errors (model failed to load); error() explains.
  // Cancelling is NOT an error: run() returns true with out->cancelled set.
  // Missing optional models degrade exactly like Android: no VAD model -> 30 s windows,
  // no diar models -> all speakers -1, no LLM -> rule minutes.
  bool run(const std::string& pcm_path, PipelineResult* out,
           const PipelineProgressFn& progress = nullptr,
           const PipelineCancelFn& cancel = nullptr);

  const std::string& error() const { return error_; }

 private:
  PipelineConfig cfg_;
  std::string error_;
};

}  // namespace audionotes
