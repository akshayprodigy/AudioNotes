// Verbale desktop CLI — the desktop host for the shared core.
//
// Full pipeline: WAV in -> VAD -> ASR -> diarize -> align -> minutes (rule floor, optionally
// LLM-enhanced) via the core's Pipeline orchestrator — the same brain every platform shell
// drives. --json writes the machine-readable result document (the eval harness input format).
// Without --vad we fall back to fixed 30 s windows over the whole file.
#include "asr/asr_chunker.h"
#include "asr/asr_engine.h"
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
                 "[--speakers N] [--diar-threshold F] [--language en|hi|auto] [--vocab \"Priya, Innova\"]\n"
                 "          [--diar-window-min M]   0 = default, negative = no windowing\n"
                 "          [--diar-speaker-threshold F]  cross-window speaker merge distance\n"
                 "          [--asr-engine whisper|qwen3|parakeet|moonshine]\n"
                 "          [--qwen3-model DIR] [--sherpa-model DIR] [--force-language]\n"
                 "          [--live-cache]         pre-decode every window, then run from cache\n"
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
  std::string vocabulary;
  // Simulates the Android live capture pass: decode every window up front, then run the pipeline
  // from that cache. A warm transcript that differs from a cold one means the cache is not the
  // pure function the whole design rests on.
  bool live_cache = false;
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
    else if (std::strcmp(argv[i], "--vocab") == 0 && i + 1 < argc) vocabulary = argv[++i];
    else if (std::strcmp(argv[i], "--live-cache") == 0) live_cache = true;
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
  cfg.vocabulary = vocabulary;

  // Pre-decode every window through the SAME decodeWindow the pipeline uses, then hand the
  // results back as a cache. This is the desktop stand-in for the live capture pass, and it is
  // what makes the parity claim checkable without a phone.
  if (live_cache) {
    if (vad_model.empty()) {
      std::fprintf(stderr, "--live-cache needs --vad: the cache is keyed on VAD chunk boundaries\n");
      return 2;
    }
    audionotes::SileroVad warm_vad(vad_model, cfg.sample_rate);
    const std::vector<audionotes::Segment> spans = warm_vad.process(pcm);
    // Through the factory, exactly as the Android live pass does: the language picks the engine,
    // and decodeWindow is on the interface so this needs no concrete type.
    audionotes::AsrConfig warm_cfg;
    warm_cfg.engine = cfg.asr_engine;
    warm_cfg.language = cfg.language;
    warm_cfg.whisper_model = cfg.asr_model;
    warm_cfg.qwen3_model_dir = cfg.qwen3_model_dir;
    warm_cfg.sherpa_model_dir = cfg.sherpa_model_dir;
    warm_cfg.skip_language_refusal = cfg.skip_language_refusal;
    std::unique_ptr<audionotes::AsrEngine> warm = audionotes::makeAsrEngine(warm_cfg);
    if (!warm->ok()) {
      std::fprintf(stderr, "--live-cache: ASR unavailable: %s\n",
                   warm->unavailableReason().c_str());
      return 1;
    }
    for (const audionotes::Chunk& c :
         audionotes::makeChunks(spans, warm->maxChunkMs(), warm->chunkMode())) {
      audionotes::AsrCachedWindow w;
      w.start_ms = c.start_ms;
      w.end_ms = c.end_ms;
      bool failed = false;
      w.utterances = warm->decodeWindow(pcm, cfg.sample_rate, c.start_ms, c.end_ms,
                                        cfg.asr_threads, &failed);
      if (!failed) cfg.chunk_cache.push_back(std::move(w));
    }
    std::fprintf(stderr, "--live-cache: pre-decoded %zu window(s)\n", cfg.chunk_cache.size());
  }

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
