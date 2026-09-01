#include "asr/qwen3_asr.h"

#include "asr/asr_chunker.h"
#include "asr/asr_postprocess.h"
#include "util/cpu_topology.h"
#include "util/ort_init.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <vector>

#ifdef HAVE_SHERPA
#include "sherpa-onnx/c-api/c-api.h"
#endif

#ifdef __ANDROID__
#include <android/log.h>
#define QWENLOGI(...) __android_log_print(ANDROID_LOG_INFO, "Qwen3Asr", __VA_ARGS__)
#else
#define QWENLOGI(...) ((void)0)
#endif

namespace audionotes {

namespace {

std::string join(const std::string& dir, const char* leaf) {
  if (dir.empty()) return leaf;
  return dir.back() == '/' ? dir + leaf : dir + "/" + leaf;
}

// sherpa's factories do not tolerate a path they cannot read: instead of returning null they
// dereference a null internal pointer and take the whole process down with SIGSEGV. A truncated
// download or a file the app cannot open is therefore a hard crash rather than a handled error,
// so check readability before handing the paths over. Same guard as Diarizer::Impl::readable.
bool readable(const std::string& path) {
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return false;
  // A zero-length or truncated .onnx parses no better than a missing one, and fails just as
  // fatally inside the session builder.
  std::fseek(f, 0, SEEK_END);
  const long bytes = std::ftell(f);
  std::fclose(f);
  return bytes > 0;
}

// Read [start_ms, end_ms) of a PCM16 mono file as float samples in [-1, 1].
std::vector<float> readWindow(const std::string& pcm_path, int sr, int64_t start_ms,
                              int64_t end_ms) {
  std::vector<float> out;
  FILE* f = std::fopen(pcm_path.c_str(), "rb");
  if (!f) return out;
  const int64_t start_sample = start_ms * sr / 1000;
  const int64_t n = std::max<int64_t>(0, (end_ms - start_ms) * sr / 1000);
  std::fseek(f, static_cast<long>(start_sample * sizeof(int16_t)), SEEK_SET);
  std::vector<int16_t> raw(static_cast<size_t>(n));
  size_t got = std::fread(raw.data(), sizeof(int16_t), raw.size(), f);
  std::fclose(f);
  out.resize(got);
  for (size_t i = 0; i < got; ++i) out[i] = static_cast<float>(raw[i]) / 32768.0f;
  return out;
}

}  // namespace

struct Qwen3Asr::Impl {
#ifdef HAVE_SHERPA
  const SherpaOnnxOfflineRecognizer* recognizer = nullptr;
#endif
  bool ok = false;
  std::string language;
  std::string model_dir;

  Impl(const std::string& dir, const std::string& lang) : language(lang), model_dir(dir) {
#ifdef HAVE_SHERPA
    const std::string conv_frontend = join(dir, "conv_frontend.onnx");
    const std::string encoder = join(dir, "encoder.onnx");
    const std::string decoder = join(dir, "decoder.onnx");
    const std::string tokenizer = join(dir, "tokenizer");

    if (!readable(conv_frontend) || !readable(encoder) || !readable(decoder)) {
      ok = false;
      return;
    }
    // sherpa-onnx is statically linked here and uses the same Ort C++ wrapper we do, so it needs
    // the shared OrtApi pointer set before any of its sessions are built. Do not assume another
    // stage has already run — this engine is reachable on its own.
    ensureOrtApi();

    SherpaOnnxOfflineRecognizerConfig config;
    std::memset(&config, 0, sizeof(config));
    config.model_config.qwen3_asr.conv_frontend = conv_frontend.c_str();
    config.model_config.qwen3_asr.encoder = encoder.c_str();
    config.model_config.qwen3_asr.decoder = decoder.c_str();
    config.model_config.qwen3_asr.tokenizer = tokenizer.c_str();
    config.model_config.qwen3_asr.max_total_len = 512;
    config.model_config.qwen3_asr.max_new_tokens = 128;
    // Effectively greedy. A transcript that cannot be reproduced cannot be scored, and scoring
    // this model against a corrected ground truth is the entire reason it is here.
    config.model_config.qwen3_asr.temperature = 1e-6f;
    config.model_config.qwen3_asr.top_p = 0.8f;
    config.model_config.qwen3_asr.seed = 42;
    // ORT fixes intra-op threads at session creation, which is why transcribe()'s `threads`
    // argument cannot be honoured per call.
    config.model_config.num_threads = inferenceThreadCount();
    config.model_config.provider = "cpu";
    config.decoding_method = "greedy_search";

    recognizer = SherpaOnnxCreateOfflineRecognizer(&config);
    ok = (recognizer != nullptr);
#else
    (void)dir;
    ok = false;
#endif
  }

  ~Impl() {
#ifdef HAVE_SHERPA
    if (recognizer) SherpaOnnxDestroyOfflineRecognizer(recognizer);
#endif
  }
};

Qwen3Asr::Qwen3Asr(const std::string& model_dir, const std::string& language)
    : impl_(new Impl(model_dir, language)) {}
Qwen3Asr::~Qwen3Asr() { delete impl_; }
bool Qwen3Asr::ok() const { return impl_->ok; }

bool Qwen3Asr::supports(const std::string& language) const {
  // Deliberately not "everything Qwen claims". This reports what we route to it, and the policy
  // table in asr_factory.cpp only gains a row once somebody has scored it.
  return language == "en" || language == "hi" || language == "auto";
}

AsrRun Qwen3Asr::transcribe(const std::string& pcm_path,
                            const std::vector<Segment>& segments,
                            int sample_rate,
                            int threads,
                            const AsrProgressFn& progress,
                            const AsrCancelFn& cancel) {
  AsrRun run;
  run.engine = name();
  run.model_path = impl_->model_dir;
  run.language = impl_->language;
  (void)threads;  // see the header: ORT fixes this at session creation.
#ifdef HAVE_SHERPA
  if (!impl_->ok) throw std::runtime_error("qwen3-asr model not loaded");

  const auto chunks = makeChunks(segments, maxChunkMs(), chunkMode());
  const int total = static_cast<int>(chunks.size());
  run.chunks_total = total;
  QWENLOGI("transcribing %d chunk(s)", total);

  for (int ci = 0; ci < total; ++ci) {
    // Between chunks is the finest cancellation granularity available; whatever decoded so far
    // is kept and returned.
    if (cancel && cancel()) {
      run.cancelled = true;
      break;
    }
    const auto& ch = chunks[ci];
    std::vector<float> samples = readWindow(pcm_path, sample_rate, ch.start_ms, ch.end_ms);
    if (samples.empty()) {
      if (progress) progress(ci + 1, total);
      continue;
    }

    const SherpaOnnxOfflineStream* stream = SherpaOnnxCreateOfflineStream(impl_->recognizer);
    if (!stream) {
      ++run.chunks_failed;
      if (progress) progress(ci + 1, total);
      continue;
    }
    // The language hint. Unhinted, this model returned pure Mandarin for one chunk in eight of a
    // Hindi recording — it is a Chinese-team model and zh is its home language. This is the same
    // value whisper is pinned with, so both engines are told the same thing.
    if (!impl_->language.empty() && impl_->language != "auto") {
      SherpaOnnxOfflineStreamSetOption(stream, "language", impl_->language.c_str());
    }
    SherpaOnnxAcceptWaveformOffline(stream, sample_rate, samples.data(),
                                    static_cast<int32_t>(samples.size()));
    SherpaOnnxDecodeOfflineStream(impl_->recognizer, stream);

    const SherpaOnnxOfflineRecognizerResult* res = SherpaOnnxGetOfflineStreamResult(stream);
    if (res && res->text) {
      if (res->lang && *res->lang && run.detected_language.empty()) {
        run.detected_language = res->lang;
      }
      // Same door as every other engine — see asr_postprocess.h.
      const std::string s = normalizeSegmentText(res->text);
      // This model returns no timestamps, so the window IS the utterance. That is exactly why
      // chunkMode() is kPerSpan: a packed window would flatten several speaking turns into one.
      if (!s.empty()) run.utterances.push_back(Utterance{ch.start_ms, ch.end_ms, s});
    } else {
      ++run.chunks_failed;
    }
    if (res) SherpaOnnxDestroyOfflineRecognizerResult(res);
    SherpaOnnxDestroyOfflineStream(stream);

    if (progress) progress(ci + 1, total);
  }
#else
  (void)pcm_path;
  (void)segments;
  (void)sample_rate;
  (void)progress;
  (void)cancel;
  throw std::runtime_error("sherpa-onnx not compiled in (vendor cpp/third_party/sherpa-onnx)");
#endif
  return run;
}

}  // namespace audionotes
