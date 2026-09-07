// Verbale desktop CLI — the desktop host for the shared core.
//
// Full pipeline: WAV in -> VAD -> ASR -> diarize -> align -> minutes (rule floor, optionally
// LLM-enhanced) via the core's Pipeline orchestrator — the same brain every platform shell
// drives. --json writes the machine-readable result document (the eval harness input format).
// Without --vad we fall back to fixed 30 s windows over the whole file.
#include "pipeline/pipeline.h"
#include "pipeline/result_json.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace {

uint32_t rd32(const unsigned char* p) {
  return p[0] | (p[1] << 8) | (p[2] << 16) | (static_cast<uint32_t>(p[3]) << 24);
}
uint16_t rd16(const unsigned char* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }

// Extract the `data` chunk of a PCM16 mono 16 kHz WAV into a headerless .pcm file — exactly the
// format the core readers (whisper_asr/silero_vad/diarizer) expect. Returns duration in ms, or -1.
// Resampling / channel-downmix is intentionally out of scope for this milestone.
int64_t wavToPcm(const std::string& wav, const std::string& pcm_out, std::string& err) {
  std::ifstream in(wav, std::ios::binary);
  if (!in) { err = "cannot open " + wav; return -1; }
  std::vector<unsigned char> buf((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  if (buf.size() < 44 || std::memcmp(buf.data(), "RIFF", 4) != 0 ||
      std::memcmp(buf.data() + 8, "WAVE", 4) != 0) {
    err = "not a RIFF/WAVE file";
    return -1;
  }

  // Walk the chunks after the 12-byte RIFF/WAVE header (chunks are word-aligned).
  size_t pos = 12;
  uint16_t channels = 0, bits = 0, fmt = 0;
  uint32_t rate = 0;
  const unsigned char* data = nullptr;
  uint32_t data_len = 0;
  while (pos + 8 <= buf.size()) {
    const unsigned char* id = buf.data() + pos;
    uint32_t sz = rd32(buf.data() + pos + 4);
    const unsigned char* body = buf.data() + pos + 8;
    if (std::memcmp(id, "fmt ", 4) == 0 && sz >= 16 && pos + 8 + 16 <= buf.size()) {
      fmt = rd16(body);
      channels = rd16(body + 2);
      rate = rd32(body + 4);
      bits = rd16(body + 14);
    } else if (std::memcmp(id, "data", 4) == 0) {
      data = body;
      data_len = static_cast<uint32_t>(std::min<size_t>(sz, buf.size() - (pos + 8)));
    }
    pos += 8 + sz + (sz & 1);
  }

  if (!data) { err = "no data chunk"; return -1; }
  if (fmt != 1 || channels != 1 || rate != 16000 || bits != 16) {
    char m[192];
    std::snprintf(m, sizeof m, "need PCM16 mono 16kHz; got fmt=%u ch=%u rate=%u bits=%u", fmt,
                  channels, rate, bits);
    err = m;
    return -1;
  }

  std::ofstream out(pcm_out, std::ios::binary);
  if (!out) { err = "cannot write " + pcm_out; return -1; }
  out.write(reinterpret_cast<const char*>(data), data_len);
  return static_cast<int64_t>(data_len) / 2 * 1000 / 16000;  // samples * 1000 / sample_rate
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr,
                 "usage: %s <whisper-model.bin> <input-16k-mono.wav> [--vad silero_vad.onnx]\n"
                 "          [--diar-seg segmentation.onnx --diar-emb embedding.onnx] "
                 "[--speakers N] [--diar-threshold F] [--language en|hi|auto]\n"
                 "          [--diar-window-min M]   0 = default, negative = no windowing\n"
                 "          [--diar-speaker-threshold F]  cross-window speaker merge distance\n"
                 "          [--asr-engine whisper|qwen3|parakeet|moonshine]\n"
                 "          [--qwen3-model DIR] [--sherpa-model DIR] [--force-language]\n"
                 "          [--llm model.gguf] [--json out.json]\n",
                 argv[0]);
    return 2;
  }
  const std::string model = argv[1];
  const std::string wav = argv[2];
  const std::string pcm = wav + ".pcm";
  std::string vad_model, diar_seg, diar_emb, llm_model, json_out;
  int num_speakers = 0;  // 0 = auto (threshold clustering), matching the Android pipeline
  float diar_threshold = 1.0f;
  // Minutes of speech to diarize at once. The A/B against un-windowed diarization is this flag
  // and not a rebuild, because a comparison you have to recompile for is one nobody re-runs.
  double diar_window_min = 0.0;
  // The cross-window speaker merge distance, which is a different quantity from --diar-threshold
  // and has to be swept separately: sherpa clusters per-segment embeddings inside a window, while
  // this compares per-speaker averages, and averaging shortens every distance it takes part in.
  double diar_speaker_threshold = 0.0;
  std::string language = "en";
  std::string asr_engine, qwen3_model, sherpa_model;
  bool force_language = false;
  for (int i = 3; i < argc; ++i) {
    if (std::strcmp(argv[i], "--vad") == 0 && i + 1 < argc) vad_model = argv[++i];
    else if (std::strcmp(argv[i], "--diar-seg") == 0 && i + 1 < argc) diar_seg = argv[++i];
    else if (std::strcmp(argv[i], "--diar-emb") == 0 && i + 1 < argc) diar_emb = argv[++i];
    else if (std::strcmp(argv[i], "--speakers") == 0 && i + 1 < argc) num_speakers = std::atoi(argv[++i]);
    else if (std::strcmp(argv[i], "--diar-threshold") == 0 && i + 1 < argc) diar_threshold = std::atof(argv[++i]);
    else if (std::strcmp(argv[i], "--diar-window-min") == 0 && i + 1 < argc) diar_window_min = std::atof(argv[++i]);
    else if (std::strcmp(argv[i], "--diar-speaker-threshold") == 0 && i + 1 < argc) diar_speaker_threshold = std::atof(argv[++i]);
    else if (std::strcmp(argv[i], "--language") == 0 && i + 1 < argc) language = argv[++i];
    else if (std::strcmp(argv[i], "--asr-engine") == 0 && i + 1 < argc) asr_engine = argv[++i];
    else if (std::strcmp(argv[i], "--qwen3-model") == 0 && i + 1 < argc) qwen3_model = argv[++i];
    else if (std::strcmp(argv[i], "--sherpa-model") == 0 && i + 1 < argc) sherpa_model = argv[++i];
    else if (std::strcmp(argv[i], "--force-language") == 0) force_language = true;
    else if (std::strcmp(argv[i], "--llm") == 0 && i + 1 < argc) llm_model = argv[++i];
    else if (std::strcmp(argv[i], "--json") == 0 && i + 1 < argc) json_out = argv[++i];
  }

#ifdef AUDIONOTES_ORT_LIB_DEFAULT
  // The build fetched a host onnxruntime; make it the default unless the user already chose one.
  setenv("AUDIONOTES_ORT_LIB", AUDIONOTES_ORT_LIB_DEFAULT, /*overwrite=*/0);
#endif

  std::string err;
  int64_t dur_ms = wavToPcm(wav, pcm, err);
  if (dur_ms < 0) {
    std::fprintf(stderr, "wav error: %s\n", err.c_str());
    return 1;
  }
  std::fprintf(stderr, "audio: %.1fs\n", dur_ms / 1000.0);

  audionotes::PipelineConfig cfg;
  cfg.asr_model = model;
  cfg.vad_model = vad_model;
  cfg.diar_seg_model = diar_seg;
  cfg.diar_emb_model = diar_emb;
  cfg.llm_model = llm_model;
  cfg.num_speakers = num_speakers;
  cfg.diar_threshold = diar_threshold;
  cfg.diar_window_ms = static_cast<int64_t>(diar_window_min * 60000.0);
  cfg.diar_speaker_threshold = static_cast<float>(diar_speaker_threshold);
  cfg.language = language;
  cfg.asr_engine = asr_engine;
  cfg.qwen3_model_dir = qwen3_model;
  cfg.sherpa_model_dir = sherpa_model;
  // The desktop mirror of "Transcribe it anyway". Present so the override can be exercised
  // against a real recording without a phone in the loop.
  cfg.skip_language_refusal = force_language;

  audionotes::Pipeline pipeline(cfg);
  audionotes::PipelineResult res;
  bool ok = pipeline.run(pcm, &res, [](const std::string& stage, int done, int total) {
    std::fprintf(stderr, "[%s] %d/%d\n", stage.c_str(), done, total);
  });
  if (!ok) {
    std::fprintf(stderr, "pipeline error: %s\n", pipeline.error().c_str());
    return 1;
  }

  std::fprintf(stderr, "vad: %zu segment(s), asr: %zu utterance(s)\n", res.segments.size(),
               res.transcript.size());
  for (const auto& u : res.transcript) {
    if (u.speaker >= 0) {
      std::printf("[%6lld-%6lld ms] S%d: %s\n", static_cast<long long>(u.start_ms),
                  static_cast<long long>(u.end_ms), u.speaker, u.text.c_str());
    } else {
      std::printf("[%6lld-%6lld ms] %s\n", static_cast<long long>(u.start_ms),
                  static_cast<long long>(u.end_ms), u.text.c_str());
    }
  }
  if (!res.minutes.empty()) {
    std::printf("\n== minutes (%s) ==\n", res.minutes_source.c_str());
    for (const auto& m : res.minutes)
      std::printf("%s: %s\n", m.kind.c_str(), m.content.c_str());
  }

  if (!json_out.empty()) {
    std::ofstream jf(json_out);
    if (!jf) {
      std::fprintf(stderr, "cannot write %s\n", json_out.c_str());
      return 1;
    }
    jf << audionotes::resultToJson(res);
    std::fprintf(stderr, "wrote %s\n", json_out.c_str());
  }
  return 0;
}
