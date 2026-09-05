#include "asr/sherpa_asr.h"

#include "asr/asr_chunker.h"
#include "asr/asr_postprocess.h"
#include "util/cpu_topology.h"
#include "util/ort_init.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef HAVE_SHERPA
#include "sherpa-onnx/c-api/c-api.h"
#endif

#ifdef __ANDROID__
#include <android/log.h>
#define SHERPALOGI(...) __android_log_print(ANDROID_LOG_INFO, "SherpaAsr", __VA_ARGS__)
#else
#define SHERPALOGI(...) ((void)0)
#endif

namespace audionotes {

namespace {

std::string join(const std::string& dir, const char* leaf) {
  if (dir.empty()) return leaf;
  return dir.back() == '/' ? dir + leaf : dir + "/" + leaf;
}

// First candidate that is actually present. Same reasoning as qwen3_asr.cpp: the published
// exports are int8-quantised and ship `encoder.int8.onnx`, not `encoder.onnx`, so those names are
// tried first — and accepting both means a full-precision export drops in without a code change.
std::string firstPresent(const std::string& dir, std::initializer_list<const char*> candidates) {
  for (const char* leaf : candidates) {
    const std::string path = join(dir, leaf);
    FILE* f = std::fopen(path.c_str(), "rb");
    if (f) {
      std::fclose(f);
      return path;
    }
  }
  return join(dir, *candidates.begin());
}

// sherpa's factories do not tolerate a path they cannot read: instead of returning null they
// dereference a null internal pointer and take the process down with SIGSEGV. Same guard as
// Qwen3Asr::Impl and Diarizer::Impl.
bool readable(const std::string& path) {
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return false;
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
  const int64_t n = end_ms > start_ms ? (end_ms - start_ms) * sr / 1000 : 0;
  std::fseek(f, static_cast<long>(start_sample * sizeof(int16_t)), SEEK_SET);
  std::vector<int16_t> raw(static_cast<size_t>(n));
  size_t got = std::fread(raw.data(), sizeof(int16_t), raw.size(), f);
  std::fclose(f);
  out.resize(got);
  for (size_t i = 0; i < got; ++i) out[i] = static_cast<float>(raw[i]) / 32768.0f;
  return out;
}

}  // namespace

struct SherpaAsr::Impl {
#ifdef HAVE_SHERPA
  const SherpaOnnxOfflineRecognizer* recognizer = nullptr;
#endif
  bool ok = false;
  Flavour flavour;
  std::string language;
  std::string model_dir;
  std::string why;  //: why ok is false, when we can say

  Impl(Flavour f, const std::string& dir, const std::string& lang)
      : flavour(f), language(lang), model_dir(dir) {
#ifdef HAVE_SHERPA
    const std::string tokens = join(dir, "tokens.txt");

    SherpaOnnxOfflineRecognizerConfig config;
    std::memset(&config, 0, sizeof(config));

    // Held at this scope because the config stores borrowed `const char*`, so every path string
    // has to outlive SherpaOnnxCreateOfflineRecognizer below. Building them inside the branch and
    // letting them die at its closing brace hands sherpa dangling pointers — which does not fail
    // loudly, it loads garbage.
    std::string encoder, decoder, joiner;
    std::string preprocessor, uncached_decoder, cached_decoder;

    if (flavour == Flavour::kParakeet) {
      // int8, then fp16, then full precision. Each published export lives in its own directory
      // with exactly one variant, so the order only decides which name is reported when a
      // directory is empty — but listing fp16 is not cosmetic: it is how the question "is the
      // quiet-audio cliff an int8 artefact or the model?" gets asked at all.
      encoder = firstPresent(dir, {"encoder.int8.onnx", "encoder.fp16.onnx", "encoder.onnx"});
      decoder = firstPresent(dir, {"decoder.int8.onnx", "decoder.fp16.onnx", "decoder.onnx"});
      joiner = firstPresent(dir, {"joiner.int8.onnx", "joiner.fp16.onnx", "joiner.onnx"});
      if (!readable(encoder) || !readable(decoder) || !readable(joiner) || !readable(tokens)) {
        why = "parakeet: missing weights in " + dir;
        std::fprintf(stderr, "%s (encoder=%d decoder=%d joiner=%d tokens=%d)\n", why.c_str(),
                     readable(encoder), readable(decoder), readable(joiner), readable(tokens));
        return;
      }
      config.model_config.transducer.encoder = encoder.c_str();
      config.model_config.transducer.decoder = decoder.c_str();
      config.model_config.transducer.joiner = joiner.c_str();
      // Not optional. A NeMo transducer and an icefall one have the same three files and
      // different blank/timestamp conventions, and sherpa picks by this string — left empty it
      // guesses, and a wrong guess decodes to plausible nonsense rather than failing.
      config.model_config.model_type = "nemo_transducer";
    } else {
      preprocessor = firstPresent(dir, {"preprocess.onnx", "preprocess.int8.onnx"});
      encoder = firstPresent(dir, {"encode.int8.onnx", "encode.fp16.onnx", "encode.onnx"});
      uncached_decoder = firstPresent(dir, {"uncached_decode.int8.onnx",
                                           "uncached_decode.fp16.onnx", "uncached_decode.onnx"});
      cached_decoder = firstPresent(dir, {"cached_decode.int8.onnx", "cached_decode.fp16.onnx",
                                         "cached_decode.onnx"});
      if (!readable(preprocessor) || !readable(encoder) || !readable(uncached_decoder) ||
          !readable(cached_decoder) || !readable(tokens)) {
        why = "moonshine: missing weights in " + dir;
        std::fprintf(stderr, "%s (pre=%d enc=%d undec=%d cdec=%d tokens=%d)\n", why.c_str(),
                     readable(preprocessor), readable(encoder), readable(uncached_decoder),
                     readable(cached_decoder), readable(tokens));
        return;
      }
      config.model_config.moonshine.preprocessor = preprocessor.c_str();
      config.model_config.moonshine.encoder = encoder.c_str();
      config.model_config.moonshine.uncached_decoder = uncached_decoder.c_str();
      config.model_config.moonshine.cached_decoder = cached_decoder.c_str();
    }

    config.model_config.tokens = tokens.c_str();
    // ORT fixes intra-op threads at session creation, which is why transcribe()'s `threads`
    // argument cannot be honoured per call. Same constraint as Qwen3Asr.
    config.model_config.num_threads = inferenceThreadCount();
    config.model_config.provider = "cpu";
    config.model_config.debug = getenv("SHERPA_DEBUG") ? 1 : 0;
    config.decoding_method = "greedy_search";

    // sherpa-onnx is statically linked here and uses the same Ort C++ wrapper we do, so the
    // shared OrtApi pointer must be set before any of its sessions are built. Do not assume
    // another stage has already run — this engine is reachable on its own.
    ensureOrtApi();

    recognizer = SherpaOnnxCreateOfflineRecognizer(&config);
    ok = (recognizer != nullptr);
    if (!ok) why = std::string(flavour == Flavour::kParakeet ? "parakeet" : "moonshine") +
                   ": sherpa refused to build a recognizer from " + dir;
#else
    (void)dir;
    why = "sherpa-onnx not compiled in";
#endif
  }

  ~Impl() {
#ifdef HAVE_SHERPA
    if (recognizer) SherpaOnnxDestroyOfflineRecognizer(recognizer);
#endif
  }
};

SherpaAsr::SherpaAsr(Flavour flavour, const std::string& model_dir, const std::string& language)
    : impl_(new Impl(flavour, model_dir, language)) {}
SherpaAsr::~SherpaAsr() { delete impl_; }

bool SherpaAsr::ok() const { return impl_->ok; }
std::string SherpaAsr::unavailableReason() const { return impl_->why; }

const char* SherpaAsr::name() const {
  return impl_->flavour == Flavour::kParakeet ? "parakeet" : "moonshine";
}

bool SherpaAsr::supports(const std::string& language) const {
  // What we ROUTE here, not what the weights might manage. Same rule as every other engine: the
  // policy table in asr_factory.cpp gains a row only once somebody has scored it.
  return language == "en" || language == "auto";
}

AsrRun SherpaAsr::transcribe(const std::string& pcm_path,
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
  if (!impl_->ok) throw std::runtime_error(impl_->why.empty() ? "sherpa asr not loaded"
                                                              : impl_->why);

  const auto chunks = makeChunks(segments, maxChunkMs(), chunkMode());
  const int total = static_cast<int>(chunks.size());
  run.chunks_total = total;

  SHERPALOGI("transcribing %d chunk(s) with %s", total, name());

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
    SherpaOnnxAcceptWaveformOffline(stream, sample_rate, samples.data(),
                                    static_cast<int32_t>(samples.size()));
    SherpaOnnxDecodeOfflineStream(impl_->recognizer, stream);

    const SherpaOnnxOfflineRecognizerResult* res = SherpaOnnxGetOfflineStreamResult(stream);
    if (res && res->text) {
      // Same door as every other engine — see asr_postprocess.h.
      const std::string s = normalizeSegmentText(res->text);
      // ONE utterance per window, spanning the whole window.
      //
      // Both models do return per-token timestamps, so finer utterances are possible — but they
      // are not needed by the question these engines are here to answer. WER concatenates the
      // whole meeting on both sides before aligning (see eval/metrics), so utterance boundaries
      // cannot move it by a single word.
      //
      // They DO move diarization attribution, which assigns a speaker per utterance: a 30-second
      // window given one label is not comparable with whisper's several. So a run of either
      // engine reports a WER worth quoting and a DER/attribution that is NOT — the eval report
      // says so rather than printing three numbers of which one silently means something else.
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
