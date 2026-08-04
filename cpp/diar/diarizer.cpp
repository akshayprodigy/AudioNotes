#include "diar/diarizer.h"

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

/**
 * Threads for the segmentation and embedding ONNX sessions.
 *
 * These defaulted to 1, which left diarization single-threaded on an 8-core phone and made it
 * cost about as much as transcription — and unlike ASR it runs over the WHOLE recording, not just
 * the VAD spans. ORT parallelises these graphs across cores well, so this is the cheapest
 * available speedup and, unlike feeding it compacted speech, it cannot change the result:
 * thread count does not affect the segmentation or the embeddings, only how fast they arrive.
 *
 * Same big.LITTLE reasoning as the ASR path — cap rather than take every core, and leave headroom
 * for the UI and the foreground service.
 */
int diarThreadCount() {
  const int hw = static_cast<int>(std::thread::hardware_concurrency());
  if (hw <= 2) return 1;
  if (hw <= 4) return hw - 1;
  return std::min(4, hw - 2);
}

// Read an entire PCM16 mono file as float samples in [-1, 1].
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
  std::string seg_model;
  std::string emb_model;
  bool ok = false;
#ifdef HAVE_SHERPA
  const SherpaOnnxOfflineSpeakerDiarization* sd = nullptr;
#endif

  Impl(const std::string& seg, const std::string& emb, int sr, int ns)
      : sample_rate(sr), num_speakers(ns), seg_model(seg), emb_model(emb) {
#ifdef HAVE_SHERPA
    const int threads = diarThreadCount();
    SherpaOnnxOfflineSpeakerDiarizationConfig config;
    memset(&config, 0, sizeof(config));
    config.segmentation.pyannote.model = seg_model.c_str();
    config.segmentation.num_threads = threads;
    config.segmentation.provider = "cpu";
    config.embedding.model = emb_model.c_str();
    config.embedding.num_threads = threads;
    config.embedding.provider = "cpu";
    config.clustering.num_clusters = num_speakers > 0 ? num_speakers : -1;
    config.clustering.threshold = 0.5f;
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
                   int sample_rate, int num_speakers)
    : impl_(new Impl(seg_model, emb_model, sample_rate, num_speakers)) {}

Diarizer::~Diarizer() { delete impl_; }
bool Diarizer::ok() const { return impl_->ok; }

std::vector<DiarSegment> Diarizer::process(const std::string& pcm_path) {
  std::vector<DiarSegment> out;
#ifdef HAVE_SHERPA
  if (!impl_->ok) throw std::runtime_error("diarization models not loaded");
  std::vector<float> samples = readAll(pcm_path);
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
#else
  (void)pcm_path;
  throw std::runtime_error("sherpa-onnx not compiled in (vendor cpp/third_party/sherpa-onnx)");
#endif
  return out;
}

}  // namespace audionotes
