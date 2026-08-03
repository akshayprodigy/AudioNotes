// libaudionotes — the shared C++ inference core.
//
// This is the platform-agnostic heart of AudioNotes. Android (JNI) and iOS (Swift/ObjC++)
// both call into this same code, so the pipeline behaves identically on both platforms.
// The three runtimes (ONNX Runtime, whisper.cpp, llama.cpp) live behind this interface.
//
// Vendor the actual engines as git submodules under cpp/ (not committed here):
//   cpp/third_party/whisper.cpp     (MIT)
//   cpp/third_party/llama.cpp       (MIT/Apache runtime; Qwen weights are Apache-2.0)
//   cpp/third_party/sherpa-onnx     (Apache-2.0; verify each model weight license)
//   cpp/third_party/onnxruntime     (MIT) — for Silero VAD
//
// Keep this header dependency-free so both platform layers can include it cheaply.
#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace audionotes {

struct Segment {      // a VAD speech span
  int64_t start_ms;
  int64_t end_ms;
};

struct Utterance {    // aligned ASR + diarization output
  int64_t start_ms;
  int64_t end_ms;
  int speaker_cluster;
  std::string text;
};

enum class Stage { Vad, Asr, Diarize, Align, Structure };

// Progress callback: (stage, done, total). Marshalled to a JS event by the platform layer.
using ProgressFn = std::function<void(Stage, int, int)>;

class Pipeline {
 public:
  // Load models from disk (paths resolved by the platform ModelManager).
  bool init(const std::string& model_dir, bool use_llm);

  // Stage 1: strip silence. Returns speech segments; chunk near 30s at these boundaries.
  std::vector<Segment> vad(const std::string& pcm_path);

  // Stage 2-4: transcribe per chunk (re-anchor whisper timestamps per chunk),
  // diarize, and align into a single ordered transcript.
  std::vector<Utterance> transcribeAndDiarize(
      const std::string& pcm_path,
      const std::vector<Segment>& segments,
      const ProgressFn& progress);

  // Stage 5: rule-based minutes floor, then optional on-device LLM enhancement
  // (chunked map-reduce for meetings > ~20 min). Returns minutes as JSON.
  std::string structure(const std::vector<Utterance>& transcript);
};

}  // namespace audionotes
