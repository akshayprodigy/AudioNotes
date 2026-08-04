#include "asr/whisper_asr.h"

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

/**
 * How many threads to give whisper.
 *
 * `hardware_concurrency() / 2` is the wrong heuristic on a big.LITTLE phone. On a Tensor G2
 * (2 x Cortex-X1 + 2 x A78 + 4 x A55) it yields 4, which the scheduler is free to place partly
 * on the little cores — and ggml runs a barrier per graph node, so the whole pass advances at the
 * speed of the SLOWEST thread. A few little cores can therefore make the job slower than using
 * fewer, faster ones.
 *
 * Big-core counts cluster tightly on Android (4 on an 8-core, 6 on a 9-12 core), so cap at 6 and
 * leave at least one core for the UI and the foreground service. Measured on a Pixel 7 Pro:
 * whisper base runs at roughly 1x realtime here, so this is the difference between a 30-minute
 * meeting taking ~19 minutes and considerably longer.
 *
 * Callers may override via the `threads` argument to transcribe() (0 = use this default).
 */
int asrThreadCount() {
  const int hw = static_cast<int>(std::thread::hardware_concurrency());
  if (hw <= 2) return 1;
  if (hw <= 4) return hw - 1;
  return std::min(6, hw - 2);
}

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

// Combine VAD spans into chunks no longer than ~kChunkMs (measured from chunk start).
std::vector<std::pair<int64_t, int64_t>> makeChunks(const std::vector<Segment>& segs) {
  std::vector<std::pair<int64_t, int64_t>> chunks;
  for (const auto& s : segs) {
    if (chunks.empty() || s.end_ms - chunks.back().first > kChunkMs) {
      chunks.emplace_back(s.start_ms, s.end_ms);
    } else {
      chunks.back().second = s.end_ms;
    }
  }
  return chunks;
}
}  // namespace

struct WhisperAsr::Impl {
#ifdef HAVE_WHISPER
  whisper_context* ctx = nullptr;
#endif
  bool ok = false;

  explicit Impl(const std::string& model_path) {
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

WhisperAsr::WhisperAsr(const std::string& model_path) : impl_(new Impl(model_path)) {}
WhisperAsr::~WhisperAsr() { delete impl_; }
bool WhisperAsr::ok() const { return impl_->ok; }

std::vector<Utterance> WhisperAsr::transcribe(
    const std::string& pcm_path,
    const std::vector<Segment>& segments,
    int sample_rate,
    int threads_override,
    const AsrProgressFn& progress) {
  std::vector<Utterance> utts;
#ifdef HAVE_WHISPER
  if (!impl_->ok) throw std::runtime_error("whisper model not loaded");

  const auto chunks = makeChunks(segments);
  const int total = static_cast<int>(chunks.size());
  const int threads = threads_override > 0 ? threads_override : asrThreadCount();
  ASRLOGI("transcribing %d chunk(s) with %d threads", total, threads);

  for (int ci = 0; ci < total; ++ci) {
    const auto& ch = chunks[ci];
    std::vector<float> samples = readWindow(pcm_path, sample_rate, ch.first, ch.second);
    if (samples.empty()) {
      if (progress) progress(ci + 1, total);
      continue;
    }

    whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    wparams.print_progress = false;
    wparams.print_realtime = false;
    wparams.print_special = false;
    wparams.translate = false;
    wparams.language = "auto";  // multilingual by default
    wparams.n_threads = threads;
    wparams.no_context = true;

    if (whisper_full(impl_->ctx, wparams, samples.data(), static_cast<int>(samples.size())) != 0) {
      if (progress) progress(ci + 1, total);
      continue;
    }

    const int n = whisper_full_n_segments(impl_->ctx);
    for (int i = 0; i < n; ++i) {
      const char* text = whisper_full_get_segment_text(impl_->ctx, i);
      // whisper t0/t1 are in centiseconds (1/100 s); re-anchor to the chunk's global start.
      const int64_t t0 = whisper_full_get_segment_t0(impl_->ctx, i) * 10;
      const int64_t t1 = whisper_full_get_segment_t1(impl_->ctx, i) * 10;
      std::string s = text ? text : "";
      // trim leading space whisper tends to add
      if (!s.empty() && s.front() == ' ') s.erase(0, 1);
      if (!s.empty()) utts.push_back(Utterance{ch.first + t0, ch.first + t1, s});
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
  return utts;
}

}  // namespace audionotes
