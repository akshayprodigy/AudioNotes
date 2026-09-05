#include "asr/whisper_asr.h"

#include "asr/asr_chunker.h"
#include "asr/asr_languages.h"
#include "asr/asr_postprocess.h"
#include "util/cpu_topology.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <stdexcept>
#include <thread>
#include <utility>
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
  //: A person overruled the refusal for this meeting. Never a default, never global.
  bool skip_refusal = false;

  Impl(const std::string& path, const std::string& lang, bool skip)
      : language(lang), model_path(path), skip_refusal(skip) {
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

WhisperAsr::WhisperAsr(const std::string& model_path, const std::string& language,
                       bool skip_language_refusal)
    : impl_(new Impl(model_path, language, skip_language_refusal)) {}
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

#ifdef HAVE_WHISPER
namespace {

//: How sure whisper must be before we refuse to transcribe somebody's meeting.
//:
//: The two mistakes are not symmetric. Refusing English that really was English destroys an hour
//: of somebody's work and they can never get it back. Accepting an unsupported language produces
//: nonsense, which is bad — but the audio is kept and can be reprocessed later. So the bar is set
//: high and ambiguity always resolves to "carry on".
//:
//: MEASURED, not guessed (2026-09-04, whisper-base):
//:
//:   bn  0.70  the real Bengali meeting, as recorded      -> refuse
//:   bn  0.76  the same audio amplified 21.6 dB           -> refuse
//:   de  0.998 clean German                               -> refuse
//:   fr  0.995 clean French                               -> refuse
//:   en  0.987 noisy English                              -> transcribe
//:   en  0.449 heavy code-switching                       -> transcribe
//:
//: 0.60 sits in the gap. The code-switching sample is the one that sets the floor: mixed speech
//: reads as LOW confidence, not as a foreign language, so it stays on the transcribing side —
//: which matters because Indian English meetings code-switch constantly and refusing one would be
//: the worse mistake.
constexpr float kRefuseConfidence = 0.60f;

/** The language whisper hears in these samples, and how sure it is. {"" , 0} if it cannot tell. */
std::pair<std::string, float> detectLanguage(whisper_context* ctx,
                                             const std::vector<float>& samples, int threads) {
  if (whisper_pcm_to_mel(ctx, samples.data(), static_cast<int>(samples.size()), threads) != 0) {
    return {std::string(), 0.f};
  }
  std::vector<float> probs(static_cast<size_t>(whisper_lang_max_id()) + 1, 0.f);
  const int id = whisper_lang_auto_detect(ctx, 0, threads, probs.data());
  if (id < 0 || static_cast<size_t>(id) >= probs.size()) return {std::string(), 0.f};
  const char* code = whisper_lang_str(id);
  return {code ? std::string(code) : std::string(), probs[static_cast<size_t>(id)]};
}

//: How many windows we listen to before deciding what language a recording is in.
//:
//: More than one, because the opening of a real meeting is the worst possible thing to judge it
//: by: greetings, cross-talk, a microphone settling, a few words over room noise. A single window
//: heard a genuinely English meeting as Turkish at p=0.88 on a Galaxy A07 — past any threshold
//: that would still catch the languages this check exists to catch. The confidence figures above
//: were all measured on clean, content-rich audio, which is not what production ever gets first.
constexpr int kDetectWindows = 5;

/**
 * Listen at several points across the recording and report what was heard at each.
 *
 * Windows are spread over the whole recording, so an atypical opening cannot decide it alone.
 * The decision itself lives in asr_languages.h, where it can be tested without an audio file.
 */
std::vector<LanguageHeard> listenForLanguage(whisper_context* ctx, const std::string& pcm_path,
                                             const std::vector<Chunk>& chunks, int sample_rate,
                                             int threads, const AsrCancelFn& cancel) {
  std::vector<LanguageHeard> heard;
  if (chunks.empty()) return heard;
  const int wanted = std::min<int>(kDetectWindows, static_cast<int>(chunks.size()));
  for (int i = 0; i < wanted; ++i) {
    if (cancel && cancel()) break;
    const size_t idx = static_cast<size_t>(static_cast<double>(i) *
                                           static_cast<double>(chunks.size()) / wanted);
    const Chunk& ch = chunks[std::min(idx, chunks.size() - 1)];
    std::vector<float> samples = readWindow(pcm_path, sample_rate, ch.start_ms, ch.end_ms);
    if (samples.empty()) continue;
    const std::pair<std::string, float> one = detectLanguage(ctx, samples, threads);
    if (one.first.empty()) continue;
    heard.push_back(LanguageHeard{one.first, one.second});
  }
  return heard;
}

}  // namespace
#endif

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

  // Decide what language this is BEFORE producing any text.
  //
  // Checked even when a language was explicitly chosen, because the choice is exactly what goes
  // wrong: the picker says English, somebody records a meeting in another language, and whisper
  // obligingly invents fluent English over it. A handful of encoder passes against a whole
  // recording of decoding, and an unsupported recording costs those passes rather than an hour
  // of CPU.
  {
    const LanguageVerdict heard =
        tallyLanguage(listenForLanguage(impl_->ctx, pcm_path, chunks, sample_rate, threads, cancel));
    run.detected_language = heard.code;
    run.detected_confidence = heard.mean_p;
    // Refuse only on AGREEMENT: a strict majority of the windows that produced an answer must
    // have heard the same unsupported language, and been confident on average. One window is not
    // evidence — that is what refused a real English meeting as Turkish.
    // The override guards ONLY this branch. Detection above still runs and still populates
    // run.detected_language / run.detected_confidence, which is what lets a forced transcript say
    // "we heard Turkish and you overruled us" rather than only "you forced this". The cost is a
    // handful of encoder passes that every run already pays.
    if (!impl_->skip_refusal && shouldRefuse(heard, kRefuseConfidence)) {
      run.unsupported_language = true;
      ASRLOGI("stopping: heard %s in %d of %d window(s) (mean p=%.2f), which this build does not "
              "transcribe",
              heard.code.c_str(), heard.votes, heard.samples, static_cast<double>(heard.mean_p));
      return run;
    }
    ASRLOGI("language: heard %s in %d of %d window(s) (mean p=%.2f)",
            heard.code.empty() ? "nothing" : heard.code.c_str(), heard.votes, heard.samples,
            static_cast<double>(heard.mean_p));
  }

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
