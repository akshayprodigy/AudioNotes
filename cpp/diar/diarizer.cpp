#include "diar/diarizer.h"

#include <algorithm>

#include "diar/span_map.h"
#include "diar/speaker_match.h"

#include "util/cpu_topology.h"
#include "util/ort_init.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <algorithm>
#include <stdexcept>
#include <thread>
#include <vector>

#ifdef HAVE_SHERPA
#include "sherpa-onnx/c-api/c-api.h"
#endif

namespace audionotes {

namespace {

#ifdef HAVE_SHERPA
// How much of one speaker's audio to average into their voice, and the least that is worth
// trying. Thirty seconds is far more than CAM++ needs and costs a few hundred milliseconds; the
// reason to take it is that a window's worth of one person is not a clean recording of them — it
// is whatever they said over other people, over the room, over the phone on the table.
constexpr int64_t kEmbedMaxMs = 30000;
constexpr int64_t kEmbedMinMs = 1000;
#endif

// The highest speaker index a window's segments mention, or -1 for none. The window contributed
// one row per speaker from 0 to this, which is what makes the row space countable.
int max_speaker_of(const std::vector<DiarSegment>& segs) {
  int highest = -1;
  for (const auto& seg : segs) highest = std::max(highest, seg.speaker);
  return highest;
}

// Read only the given speech spans, laid end to end, as float samples in [-1, 1].
//
// Reading speech instead of the whole file saves 13-38% on a real meeting (measured with
// eval/speech_fraction.py) — worth having, and it improved DER, but it is not what makes a long
// meeting fit. That is the caller's job: it hands this function one WINDOW of spans at a time, so
// the buffer below is bounded by the window and not by the recording. Seeking per span costs one
// fseek each and reads only what somebody actually said.
std::vector<float> readSpans(const std::string& pcm_path, const std::vector<Span>& spans,
                             int sample_rate) {
  std::vector<float> out;
  FILE* f = std::fopen(pcm_path.c_str(), "rb");
  if (!f) return out;
  std::fseek(f, 0, SEEK_END);
  const long bytes = std::ftell(f);
  if (bytes <= 0) {
    std::fclose(f);
    return out;
  }
  const int64_t total_samples = static_cast<int64_t>(bytes) / 2;
  // Widened deliberately: 32-bit ABIs are still a shipped target (armeabi-v7a), and doing
  // this multiplication in size_t there overflows above about four and a half minutes of
  // speech — which reserves a tiny buffer and then reallocates through the whole read.
  out.reserve(static_cast<size_t>(totalSpeechMs(spans) * sample_rate / 1000));

  std::vector<int16_t> raw;
  for (const auto& sp : spans) {
    int64_t from = sp.start_ms * sample_rate / 1000;
    int64_t to = sp.end_ms * sample_rate / 1000;
    // A span past the end of the file is not an error worth failing the meeting for: VAD ran on
    // this same audio, but a truncated write or a resumed capture can leave the two disagreeing.
    from = std::max<int64_t>(0, std::min(from, total_samples));
    to = std::max<int64_t>(from, std::min(to, total_samples));
    const size_t n = static_cast<size_t>(to - from);
    if (n == 0) continue;
    if (std::fseek(f, static_cast<long>(from * 2), SEEK_SET) != 0) break;
    raw.resize(n);
    const size_t got = std::fread(raw.data(), sizeof(int16_t), n, f);
    for (size_t i = 0; i < got; ++i) out.push_back(static_cast<float>(raw[i]) / 32768.0f);
  }
  std::fclose(f);
  return out;
}

// Read an entire PCM16 mono file as float samples in [-1, 1]. Kept for the no-spans path.
std::vector<float> readAll(const std::string& pcm_path) {
  std::vector<float> out;
  FILE* f = std::fopen(pcm_path.c_str(), "rb");
  if (!f) return out;
  std::fseek(f, 0, SEEK_END);
  long bytes = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  if (bytes <= 0) {
    std::fclose(f);
    return out;
  }
  const size_t n = static_cast<size_t>(bytes) / sizeof(int16_t);
  std::vector<int16_t> raw(n);
  size_t got = std::fread(raw.data(), sizeof(int16_t), n, f);
  std::fclose(f);
  out.resize(got);
  for (size_t i = 0; i < got; ++i) out[i] = static_cast<float>(raw[i]) / 32768.0f;
  return out;
}
}  // namespace

struct Diarizer::Impl {
  int sample_rate;
  int num_speakers;
  float threshold;
  float speaker_match_threshold;
  std::string seg_model;
  std::string emb_model;
  bool ok = false;
#ifdef HAVE_SHERPA
  const SherpaOnnxOfflineSpeakerDiarization* sd = nullptr;
  // The same embedding model the diarizer clusters with, reachable on its own. Windows are
  // clustered independently, so something has to say whether two windows' speakers are the same
  // person, and the only honest answer is their voices. Created lazily: a meeting short enough to
  // fit one window never needs it.
  const SherpaOnnxSpeakerEmbeddingExtractor* embedder = nullptr;
  bool embedder_tried = false;

  const SherpaOnnxSpeakerEmbeddingExtractor* embeddingExtractor() {
    if (embedder_tried) return embedder;
    embedder_tried = true;
    SherpaOnnxSpeakerEmbeddingExtractorConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.model = emb_model.c_str();
    cfg.num_threads = inferenceThreadCount();
    cfg.provider = "cpu";
    embedder = SherpaOnnxCreateSpeakerEmbeddingExtractor(&cfg);
    return embedder;
  }
#endif

  // sherpa's factory does not tolerate a model path it cannot read: instead of returning null it
  // dereferences a null internal pointer and takes the whole process down with SIGSEGV. A
  // truncated download or a file the app has no permission to open is therefore a hard crash
  // rather than a handled error, so check readability here before handing the paths over.
  static bool readable(const std::string& path) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    // Guard against a zero-length or truncated file too — an empty .onnx parses no better than
    // a missing one, and fails just as fatally inside the session builder.
    std::fseek(f, 0, SEEK_END);
    const long bytes = std::ftell(f);
    std::fclose(f);
    return bytes > 0;
  }

  Impl(const std::string& seg, const std::string& emb, int sr, int ns, float thr, float match_thr)
      : sample_rate(sr), num_speakers(ns), threshold(thr), speaker_match_threshold(match_thr),
        seg_model(seg), emb_model(emb) {
#ifdef HAVE_SHERPA
    if (!readable(seg_model) || !readable(emb_model)) {
      ok = false;
      return;
    }
    // sherpa-onnx is statically linked here and uses the same Ort C++ wrapper we do, so it needs
    // the shared OrtApi pointer set before any of its sessions are built. Do not assume the VAD
    // has already run: diarization is reachable on its own.
    ensureOrtApi();
    // Segmentation and embedding both default to 1 thread in sherpa's config, which left
    // diarization single-threaded while covering the WHOLE recording (not just the VAD spans).
    // Thread count cannot change the result here, only how fast it arrives.
    const int threads = inferenceThreadCount();
    SherpaOnnxOfflineSpeakerDiarizationConfig config;
    memset(&config, 0, sizeof(config));
    config.segmentation.pyannote.model = seg_model.c_str();
    config.segmentation.num_threads = threads;
    config.segmentation.provider = "cpu";
    config.embedding.model = emb_model.c_str();
    config.embedding.num_threads = threads;
    config.embedding.provider = "cpu";
    config.clustering.num_clusters = num_speakers > 0 ? num_speakers : -1;
    config.clustering.threshold = threshold;
    config.min_duration_on = 0.3f;
    config.min_duration_off = 0.5f;
    sd = SherpaOnnxCreateOfflineSpeakerDiarization(&config);
    ok = (sd != nullptr);
#else
    ok = false;
#endif
  }

#ifdef HAVE_SHERPA
  // Diarize one buffer. Timestamps come back in that buffer's own milliseconds, which for a
  // window means concatenated-window time and not the recording's.
  std::vector<DiarSegment> diarize(const std::vector<float>& samples) {
    std::vector<DiarSegment> out;
    const SherpaOnnxOfflineSpeakerDiarizationResult* result =
        SherpaOnnxOfflineSpeakerDiarizationProcess(sd, samples.data(),
                                                   static_cast<int32_t>(samples.size()));
    if (!result) return out;
    const int32_t n = SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments(result);
    const SherpaOnnxOfflineSpeakerDiarizationSegment* segs =
        SherpaOnnxOfflineSpeakerDiarizationResultSortByStartTime(result);
    out.reserve(static_cast<size_t>(n));
    for (int32_t i = 0; i < n; ++i) {
      out.push_back(DiarSegment{static_cast<int64_t>(segs[i].start * 1000.0f),
                                static_cast<int64_t>(segs[i].end * 1000.0f),
                                segs[i].speaker});
    }
    SherpaOnnxOfflineSpeakerDiarizationDestroySegment(segs);
    SherpaOnnxOfflineSpeakerDiarizationDestroyResult(result);
    return out;
  }

  // Gather up to kEmbedMaxMs of one speaker's audio out of the window's buffer.
  //
  // Longest turns first, deliberately. A speaker's short segments are where diarization is least
  // sure and where the other person's voice is most likely to have leaked in, so averaging them
  // into the vector that decides identity across the whole meeting is the wrong trade.
  std::vector<float> collectSpeaker(const std::vector<float>& samples,
                                    const std::vector<DiarSegment>& segs, int speaker) const {
    std::vector<float> voice;
    std::vector<const DiarSegment*> mine;
    for (const auto& seg : segs) {
      if (seg.speaker == speaker && seg.end_ms > seg.start_ms) mine.push_back(&seg);
    }
    std::sort(mine.begin(), mine.end(), [](const DiarSegment* a, const DiarSegment* b) {
      const int64_t da = a->end_ms - a->start_ms, db = b->end_ms - b->start_ms;
      if (da != db) return da > db;
      return a->start_ms < b->start_ms;  // ties broken by time, so the result is reproducible
    });

    int64_t taken_ms = 0;
    for (const DiarSegment* seg : mine) {
      if (taken_ms >= kEmbedMaxMs) break;
      const int64_t want_ms = std::min(seg->end_ms - seg->start_ms, kEmbedMaxMs - taken_ms);
      int64_t from = seg->start_ms * sample_rate / 1000;
      int64_t to = from + want_ms * sample_rate / 1000;
      from = std::max<int64_t>(0, std::min<int64_t>(from, static_cast<int64_t>(samples.size())));
      to = std::max(from, std::min<int64_t>(to, static_cast<int64_t>(samples.size())));
      if (to <= from) continue;
      voice.insert(voice.end(), samples.begin() + from, samples.begin() + to);
      taken_ms += (to - from) * 1000 / sample_rate;
    }
    if (taken_ms < kEmbedMinMs) voice.clear();
    return voice;
  }

  // One voice in, one embedding out. Empty on any failure — no extractor, not enough audio,
  // sherpa not ready — and the caller treats empty as "could not match this speaker" rather than
  // as a reason to fail the meeting.
  std::vector<float> embed(const std::vector<float>& voice) {
    std::vector<float> out;
    if (voice.empty()) return out;
    const SherpaOnnxSpeakerEmbeddingExtractor* ex = embeddingExtractor();
    if (!ex) return out;
    const SherpaOnnxOnlineStream* stream = SherpaOnnxSpeakerEmbeddingExtractorCreateStream(ex);
    if (!stream) return out;
    SherpaOnnxOnlineStreamAcceptWaveform(stream, sample_rate, voice.data(),
                                         static_cast<int32_t>(voice.size()));
    SherpaOnnxOnlineStreamInputFinished(stream);
    if (SherpaOnnxSpeakerEmbeddingExtractorIsReady(ex, stream)) {
      const int32_t d = SherpaOnnxSpeakerEmbeddingExtractorDim(ex);
      const float* v = SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(ex, stream);
      if (v && d > 0) {
        out.assign(v, v + d);
        SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding(v);
      }
    }
    SherpaOnnxDestroyOnlineStream(stream);
    return out;
  }
#endif

  ~Impl() {
#ifdef HAVE_SHERPA
    if (sd) SherpaOnnxDestroyOfflineSpeakerDiarization(sd);
    if (embedder) SherpaOnnxDestroySpeakerEmbeddingExtractor(embedder);
#endif
  }
};

Diarizer::Diarizer(const std::string& seg_model, const std::string& emb_model,
                   int sample_rate, int num_speakers, float threshold,
                   float speaker_match_threshold)
    : impl_(new Impl(seg_model, emb_model, sample_rate, num_speakers, threshold,
                     speaker_match_threshold)) {}

Diarizer::~Diarizer() { delete impl_; }
bool Diarizer::ok() const { return impl_->ok; }

std::vector<DiarSegment> Diarizer::process(const std::string& pcm_path) {
  return process(pcm_path, {});
}

std::vector<DiarSegment> Diarizer::process(const std::string& pcm_path,
                                           const std::vector<Span>& spans) {
  return process(pcm_path, spans, 0);
}

std::vector<DiarSegment> Diarizer::process(const std::string& pcm_path,
                                           const std::vector<Span>& spans,
                                           int64_t window_ms) {
  std::vector<DiarSegment> out;
#ifdef HAVE_SHERPA
  if (!impl_->ok) throw std::runtime_error("diarization models not loaded");

  // Without spans there is nothing to window on: the caller has not run VAD, so we do not know
  // where the speech is and cannot cut anywhere that is not arbitrary. Whole file, one buffer —
  // the old behaviour, kept honest rather than kept quiet.
  if (spans.empty()) {
    std::vector<float> samples = readAll(pcm_path);
    if (samples.empty()) return out;
    return impl_->diarize(samples);
  }

  // Pad before reading. Bare VAD spans butt one speaker's turn straight against the next, which
  // segmentation reads as a speaker change that never happened — measured on AMI ES2003a as DER
  // 16.4% -> 24.1%. The padding puts the real silence back at the boundaries.
  int64_t total_ms = 0;
  if (FILE* f = std::fopen(pcm_path.c_str(), "rb")) {
    std::fseek(f, 0, SEEK_END);
    const long bytes = std::ftell(f);
    std::fclose(f);
    if (bytes > 0) total_ms = (static_cast<int64_t>(bytes) / 2) * 1000 / impl_->sample_rate;
  }
  const std::vector<Span> padded = padAndMerge(spans, kDiarPadMs, total_ms);

  // A fixed speaker count is a statement about the WHOLE recording and cannot be honoured a window
  // at a time: asking each window for four clusters when only two people speak in it invents two.
  // Nothing in the app sets this — it exists for the CLI — so the simple answer is the right one.
  int64_t effective_window = window_ms == 0 ? kDiarWindowMs : window_ms;
  if (impl_->num_speakers > 0) effective_window = -1;
  const std::vector<std::vector<Span>> windows = windowSpans(padded, effective_window);
  if (windows.empty()) return out;

  // One window is the common case — anything up to ten minutes of actual speech, which is most
  // meetings — and it takes the path this code took before windowing existed: sherpa's own
  // clustering already spans everything there is, so there is nothing to reconcile and no
  // embedding pass to pay for.
  if (windows.size() == 1) {
    std::vector<float> samples = readSpans(pcm_path, windows[0], impl_->sample_rate);
    if (samples.empty()) return out;
    return toOriginalTimeline(impl_->diarize(samples), windows[0]);
  }

  // Every window numbers its speakers from zero and means something different by it. Segments are
  // parked against a per-window row index and the rows are clustered on their voices at the end;
  // until then a "speaker" in `out` is a row, not a person.
  //
  // One vector per row, kept separate until that end. Flattening them as they arrive looks tidier
  // and is wrong: the embedding dimension is not known until the first one succeeds, so any
  // speaker that failed to embed before that would be written at the wrong length and every row
  // after it read from the wrong offset — speech attributed by arithmetic rather than by voice,
  // silently.
  std::vector<std::vector<float>> voices;
  // Which window each row came from. Two rows sharing one are two people sherpa already separated
  // with that window's full per-segment evidence, and the clustering below must not overrule it.
  std::vector<int> row_window;
  int dim = 0;
  int window_index = 0;
  for (const auto& window : windows) {
    // Scoped so the window's audio is freed before the next window's is read. This is the whole
    // point of windowing: the peak follows the window, not the meeting.
    std::vector<DiarSegment> local;
    {
      std::vector<float> samples = readSpans(pcm_path, window, impl_->sample_rate);
      if (samples.empty()) continue;
      local = impl_->diarize(samples);
      if (local.empty()) continue;

      const int max_speaker = max_speaker_of(local);
      for (int sp = 0; sp <= max_speaker; ++sp) {
        std::vector<float> emb = impl_->embed(impl_->collectSpeaker(samples, local, sp));
        if (!emb.empty() && dim == 0) dim = static_cast<int>(emb.size());
        // A speaker we could not embed — too little audio, or no extractor — is left empty and
        // becomes zeros below. clusterEmbeddings gives those their own label rather than merging
        // them into whoever came first, which turns an unmatchable voice into an extra speaker
        // the user can merge by hand instead of a misattribution nobody can see.
        voices.push_back(std::move(emb));
        row_window.push_back(window_index);
      }
    }
    // `local` still carries this window's OWN speaker numbering, and it has to: collectSpeaker
    // above matches on it. The shift into the global row space therefore happens HERE, on the way
    // out, rather than in place beforehand — an in-place shift reads as tidier and puts a silent
    // ordering trap in the loop, where hoisting one line above the embedding pass would make every
    // collectSpeaker match nothing and quietly return one speaker per window per person.
    const int base = static_cast<int>(voices.size()) - (max_speaker_of(local) + 1);
    for (DiarSegment seg : toOriginalTimeline(local, window)) {
      seg.speaker += base;
      out.push_back(seg);
    }
    // Counted per window that produced rows, not per iteration: a window that read no audio or
    // returned no segments contributes no rows, and giving it an index would leave a gap that the
    // constraint would read as a window nobody spoke in.
    ++window_index;
  }

  if (out.empty()) return out;

  // If nothing embedded there is no dimension and no matching to do, so every window keeps its own
  // speakers: the result over-splits visibly rather than merging blindly, which is the failure the
  // user can see and undo.
  const int rows = static_cast<int>(voices.size());
  if (dim > 0 && rows > 0) {
    std::vector<float> embeddings(static_cast<size_t>(rows) * static_cast<size_t>(dim), 0.0f);
    for (int r = 0; r < rows; ++r) {
      // A row of the wrong length can only come from two extractors disagreeing, which cannot
      // happen with one model — but it would corrupt every row after it, so it is left as zeros.
      if (static_cast<int>(voices[static_cast<size_t>(r)].size()) != dim) continue;
      std::copy(voices[static_cast<size_t>(r)].begin(), voices[static_cast<size_t>(r)].end(),
                embeddings.begin() + static_cast<size_t>(r) * dim);
    }
    const std::vector<int> labels =
        clusterEmbeddings(embeddings, rows, dim, impl_->speaker_match_threshold,
                          Linkage::AVERAGE, row_window);
    if (static_cast<int>(labels.size()) == rows) {
      for (auto& seg : out) {
        if (seg.speaker >= 0 && seg.speaker < rows) seg.speaker = labels[seg.speaker];
      }
    }
  }

  std::sort(out.begin(), out.end(), [](const DiarSegment& a, const DiarSegment& b) {
    if (a.start_ms != b.start_ms) return a.start_ms < b.start_ms;
    return a.end_ms < b.end_ms;
  });
#else
  (void)pcm_path;
  (void)spans;
  (void)window_ms;
  throw std::runtime_error("sherpa-onnx not compiled in (vendor cpp/third_party/sherpa-onnx)");
#endif
  return out;
}

}  // namespace audionotes
