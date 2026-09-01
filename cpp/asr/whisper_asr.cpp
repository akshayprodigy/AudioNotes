#include "asr/whisper_asr.h"

#include "asr/asr_chunker.h"
#include "asr/asr_postprocess.h"
#include "util/cpu_topology.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
#include <thread>
#include <vector>

#ifdef HAVE_WHISPER
#include "whisper.h"
#endif

#ifdef __ANDROID__
#include <android/log.h>
#define ASRLOGI(...) __android_log_print(ANDROID_LOG_INFO, "WhisperAsr", __VA_ARGS__)
#else
#define ASRLOGI(...) ((void)0)
#endif

namespace audionotes {

namespace {
constexpr int64_t kChunkMs = 30000;  // combine VAD spans up to ~30s per whisper pass

// Read [start_ms, end_ms) of a PCM16 mono file as float samples in [-1, 1].
std::vector<float> readWindow(const std::string& pcm_path, int sr, int64_t start_ms, int64_t end_ms) {
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

struct WhisperAsr::Impl {
#ifdef HAVE_WHISPER
  whisper_context* ctx = nullptr;
#endif
  bool ok = false;
  std::string language;
  std::string model_path;

  Impl(const std::string& path, const std::string& lang) : language(lang), model_path(path) {
#ifdef HAVE_WHISPER
    whisper_context_params cparams = whisper_context_default_params();
    ctx = whisper_init_from_file_with_params(model_path.c_str(), cparams);
    ok = (ctx != nullptr);
#else
    (void)model_path;
    ok = false;
#endif
  }

  ~Impl() {
#ifdef HAVE_WHISPER
    if (ctx) whisper_free(ctx);
#endif
  }
};

WhisperAsr::WhisperAsr(const std::string& model_path, const std::string& language)
    : impl_(new Impl(model_path, language)) {}
WhisperAsr::~WhisperAsr() { delete impl_; }
bool WhisperAsr::ok() const { return impl_->ok; }

bool WhisperAsr::supports(const std::string& language) const {
#ifdef HAVE_WHISPER
  // "auto" is not a language, it is the absence of a choice — still accepted, still not default.
  if (language == "auto") return true;
  return whisper_lang_id(language.c_str()) >= 0;
#else
  (void)language;
  return false;
#endif
}

AsrRun WhisperAsr::transcribe(
    const std::string& pcm_path,
    const std::vector<Segment>& segments,
    int sample_rate,
    int threads_override,
    const AsrProgressFn& progress,
    const AsrCancelFn& cancel) {
  AsrRun run;
  run.engine = name();
  run.model_path = impl_->model_path;
  run.language = impl_->language;
#ifdef HAVE_WHISPER
  if (!impl_->ok) throw std::runtime_error("whisper model not loaded");

  const auto chunks = makeChunks(segments, kChunkMs);
  const int total = static_cast<int>(chunks.size());
  run.chunks_total = total;
  const int threads = threads_override > 0 ? threads_override : inferenceThreadCount();
  ASRLOGI("transcribing %d chunk(s) with %d threads", total, threads);

  for (int ci = 0; ci < total; ++ci) {
    // Between chunks is the finest cancellation granularity whisper_full() allows us without an
    // abort callback; utterances decoded so far are kept and returned.
    if (cancel && cancel()) {
      ASRLOGI("cancelled after %d/%d chunk(s)", ci, total);
      run.cancelled = true;
      break;
    }
    const auto& ch = chunks[ci];
    std::vector<float> samples = readWindow(pcm_path, sample_rate, ch.start_ms, ch.end_ms);
    if (samples.empty()) {
      if (progress) progress(ci + 1, total);
      continue;
    }

    whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    wparams.print_progress = false;
    wparams.print_realtime = false;
    wparams.print_special = false;
    wparams.translate = false;
    wparams.language = impl_->language.c_str();
    wparams.n_threads = threads;
    wparams.no_context = true;

    if (whisper_full(impl_->ctx, wparams, samples.data(), static_cast<int>(samples.size())) != 0) {
      // Counted, not swallowed. A run where every chunk lands here used to be indistinguishable
      // from a silent room, and the pipeline called both "no speech detected".
      ++run.chunks_failed;
      if (progress) progress(ci + 1, total);
      continue;
    }

    const int n = whisper_full_n_segments(impl_->ctx);
    for (int i = 0; i < n; ++i) {
      const char* text = whisper_full_get_segment_text(impl_->ctx, i);
      // whisper t0/t1 are in centiseconds (1/100 s); re-anchor to the chunk's global start.
      const int64_t t0 = whisper_full_get_segment_t0(impl_->ctx, i) * 10;
      const int64_t t1 = whisper_full_get_segment_t1(impl_->ctx, i) * 10;
      // whisper returns raw decoded token bytes. A character split across a chunk boundary
      // arrives as a fragment, and that fragment terminates every consumer downstream (JSON
      // dump throws, JNI NewStringUTF aborts the VM) — found on a Hindi/English meeting, after
      // the whole recording had already been processed. Scrub once, here at the source.
      // Every engine's output goes through the same door — see asr_postprocess.h for the two
      // crashes that door exists to stop, and why an engine must not do this itself. The minutes
      // are extracted from this text and an action's item hash is computed over it, so cleaning
      // it downstream would leave two strings both claiming to be the same utterance.
      const std::string s = normalizeSegmentText(text ? text : "");
      if (!s.empty()) run.utterances.push_back(Utterance{ch.start_ms + t0, ch.start_ms + t1, s});
    }
    if (progress) progress(ci + 1, total);
  }
#else
  (void)pcm_path;
  (void)segments;
  (void)sample_rate;
  (void)progress;
  throw std::runtime_error("whisper.cpp not compiled in (vendor cpp/third_party/whisper.cpp)");
#endif
  return run;
}

}  // namespace audionotes
