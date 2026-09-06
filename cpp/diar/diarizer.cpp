#include "diar/diarizer.h"

#include <algorithm>

#include "diar/span_map.h"

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

// Read only the given speech spans, laid end to end, as float samples in [-1, 1].
//
// The whole-file version this replaces was the reason diarization could not finish a long
// meeting: 90 minutes at 16 kHz is a 346 MB float vector before sherpa copies it, and every
// silent second in it was segmented and embedded for nothing. Seeking per span costs one fseek
// each and reads only what somebody actually said.
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
  out.reserve(static_cast<size_t>(totalSpeechMs(spans)) * sample_rate / 1000);

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
  std::string seg_model;
  std::string emb_model;
  bool ok = false;
#ifdef HAVE_SHERPA
  const SherpaOnnxOfflineSpeakerDiarization* sd = nullptr;
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

  Impl(const std::string& seg, const std::string& emb, int sr, int ns, float thr)
      : sample_rate(sr), num_speakers(ns), threshold(thr), seg_model(seg), emb_model(emb) {
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

  ~Impl() {
#ifdef HAVE_SHERPA
    if (sd) SherpaOnnxDestroyOfflineSpeakerDiarization(sd);
#endif
  }
};

Diarizer::Diarizer(const std::string& seg_model, const std::string& emb_model,
                   int sample_rate, int num_speakers, float threshold)
    : impl_(new Impl(seg_model, emb_model, sample_rate, num_speakers, threshold)) {}

Diarizer::~Diarizer() { delete impl_; }
bool Diarizer::ok() const { return impl_->ok; }

std::vector<DiarSegment> Diarizer::process(const std::string& pcm_path) {
  return process(pcm_path, {});
}

std::vector<DiarSegment> Diarizer::process(const std::string& pcm_path,
                                           const std::vector<Span>& spans) {
  std::vector<DiarSegment> out;
#ifdef HAVE_SHERPA
  if (!impl_->ok) throw std::runtime_error("diarization models not loaded");
  // With spans, only speech is read and the results come back on a timeline that has the silence
  // removed — so they have to be put back. Without them (a caller that has not run VAD) the old
  // whole-file behaviour still applies and no translation is needed.
  const bool use_spans = !spans.empty();
  // Pad before reading. Bare VAD spans butt one speaker's turn straight against the next, which
  // segmentation reads as a speaker change that never happened — measured on AMI ES2003a as DER
  // 16.4% -> 24.1%. The padding puts the real silence back at the boundaries; the long gaps in
  // between are still skipped, which is where the memory was going.
  std::vector<Span> padded;
  if (use_spans) {
    int64_t total_ms = 0;
    if (FILE* f = std::fopen(pcm_path.c_str(), "rb")) {
      std::fseek(f, 0, SEEK_END);
      const long bytes = std::ftell(f);
      std::fclose(f);
      if (bytes > 0) total_ms = (static_cast<int64_t>(bytes) / 2) * 1000 / impl_->sample_rate;
    }
    padded = padAndMerge(spans, kDiarPadMs, total_ms);
  }
  std::vector<float> samples =
      use_spans ? readSpans(pcm_path, padded, impl_->sample_rate) : readAll(pcm_path);
  if (samples.empty()) return out;

  const SherpaOnnxOfflineSpeakerDiarizationResult* result =
      SherpaOnnxOfflineSpeakerDiarizationProcess(
          impl_->sd, samples.data(), static_cast<int32_t>(samples.size()));
  if (!result) return out;

  const int32_t n = SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments(result);
  const SherpaOnnxOfflineSpeakerDiarizationSegment* segs =
      SherpaOnnxOfflineSpeakerDiarizationResultSortByStartTime(result);
  out.reserve(n);
  for (int32_t i = 0; i < n; ++i) {
    out.push_back(DiarSegment{
        static_cast<int64_t>(segs[i].start * 1000.0f),
        static_cast<int64_t>(segs[i].end * 1000.0f),
        segs[i].speaker});
  }
  SherpaOnnxOfflineSpeakerDiarizationDestroySegment(segs);
  SherpaOnnxOfflineSpeakerDiarizationDestroyResult(result);
  // Mapped against the PADDED spans, because those are what was actually concatenated.
  if (use_spans) out = toOriginalTimeline(out, padded);
#else
  (void)pcm_path;
  (void)spans;
  throw std::runtime_error("sherpa-onnx not compiled in (vendor cpp/third_party/sherpa-onnx)");
#endif
  return out;
}

}  // namespace audionotes
