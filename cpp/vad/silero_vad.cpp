#include "vad/silero_vad.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <dlfcn.h>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef __ANDROID__
#include <android/log.h>
#define VADLOGI(...) __android_log_print(ANDROID_LOG_INFO, "SileroVad", __VA_ARGS__)
#else
#define VADLOGI(...) ((void)0)
#endif

// Manual init: don't reference OrtGetApiBase from the header, so we don't link libonnxruntime.so
// at build time. We resolve it at runtime via dlopen (the .so is shipped by the onnxruntime-android
// AAR and packaged in the APK). This removes the need for a prefab CMake config / find_package.
#define ORT_API_MANUAL_INIT
#include "onnxruntime_cxx_api.h"

// The bootstrap used to live here as a file-local helper, which quietly made the VAD the only
// engine that initialised the shared OrtApi — see util/ort_init.h for why that broke diarization.
#include "util/ort_init.h"
#include "vad/vad_span_builder.h"

namespace audionotes {

struct SileroVad::Impl {
  int sample_rate;
  Ort::Env env;
  Ort::SessionOptions opts;
  Ort::Session session;
  Ort::MemoryInfo mem;

  std::vector<std::string> input_names;
  std::vector<std::string> output_names;
  std::vector<const char*> in_c;
  std::vector<const char*> out_c;
  bool v5 = false;  // v5: single "state" tensor; v4: separate h/c

  int64_t sr_val;
  std::vector<float> h;      // v4: [2,1,64]
  std::vector<float> c;      // v4: [2,1,64]
  std::vector<float> state;  // v5: [2,1,128]

  /**
   * v5 only: the last 64 samples of the previous frame, prepended to the next one.
   *
   * Silero v5 is trained on 576-sample inputs at 16 kHz (64 samples of context + a 512-sample
   * hop), and the ONNX graph's sample axis is dynamic — so feeding a bare 512 does NOT error,
   * it just silently produces meaningless probabilities. That reads as "no speech anywhere".
   * v4 has no context input and is fed the raw 512.
   */
  std::vector<float> context;
  static constexpr size_t kContext16k = 64;

  /** Highest probability seen in the last process() run — used for diagnostics. */
  float max_prob = 0.0f;

  // Streaming state. `builder` is null until reset() opens a stream.
  std::unique_ptr<VadSpanBuilder> builder;
  VadConfig cfg;
  // Bytes fed that did not complete a frame. BYTES, not samples: a caller may hand over an odd
  // number of them — a truncated write, or a resumed capture — and dropping the spare byte would
  // shift every later sample by one and reinterpret the whole recording as noise.
  std::vector<uint8_t> residual;
  int64_t stream_cursor = 0;      // samples consumed by the stream so far

  Impl(const std::string& model_path, int sr)
      : sample_rate(sr),
        env(ORT_LOGGING_LEVEL_WARNING, "audionotes-vad"),
        opts(),
        session(nullptr),
        mem(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)),
        sr_val(sr),
        h(2 * 1 * 64, 0.0f),
        c(2 * 1 * 64, 0.0f),
        state(2 * 1 * 128, 0.0f),
        context(kContext16k, 0.0f) {
    opts.SetIntraOpNumThreads(1);
#if defined(__arm__) && !defined(__aarch64__)
    // 32-bit ARM is a bench-only build (the 2019 Galaxy Tab A). The prebuilt 32-bit ORT faults
    // (SIGBUS, BUS_ADRALN) inside its optimiser while loading this model; the un-optimised graph
    // is slower and loads. Never shipped: every 64-bit target keeps ORT_ENABLE_ALL below.
    opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_DISABLE_ALL);
#else
    opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
#endif
    session = Ort::Session(env, model_path.c_str(), opts);

    Ort::AllocatorWithDefaultOptions alloc;
    for (size_t i = 0; i < session.GetInputCount(); ++i) {
      input_names.emplace_back(session.GetInputNameAllocated(i, alloc).get());
    }
    for (size_t i = 0; i < session.GetOutputCount(); ++i) {
      output_names.emplace_back(session.GetOutputNameAllocated(i, alloc).get());
    }
    for (const auto& n : input_names) {
      in_c.push_back(n.c_str());
      if (n == "state") v5 = true;
    }
    for (const auto& n : output_names) out_c.push_back(n.c_str());
  }

  void reset() {
    std::fill(h.begin(), h.end(), 0.0f);
    std::fill(c.begin(), c.end(), 0.0f);
    std::fill(state.begin(), state.end(), 0.0f);
    std::fill(context.begin(), context.end(), 0.0f);
    max_prob = 0.0f;
  }

  // Run one frame; returns speech probability and advances the recurrent state.
  // Works for both Silero v4 (input/sr/h/c -> output/hn/cn) and v5 (input/state/sr -> output/stateN).
  float infer(std::vector<float>& frame) {
    // v5: prepend the previous frame's tail so the model sees the 576 samples it expects.
    std::vector<float> buf;
    if (v5) {
      buf.reserve(context.size() + frame.size());
      buf.insert(buf.end(), context.begin(), context.end());
      buf.insert(buf.end(), frame.begin(), frame.end());
      context.assign(frame.end() - std::min(frame.size(), kContext16k), frame.end());
    }
    std::vector<float>& in = v5 ? buf : frame;

    const int64_t in_dims[2] = {1, static_cast<int64_t>(in.size())};
    const int64_t sr_dims[1] = {1};
    const int64_t hc_dims[3] = {2, 1, 64};
    const int64_t st_dims[3] = {2, 1, 128};

    std::vector<Ort::Value> inputs;
    inputs.reserve(input_names.size());
    for (const auto& name : input_names) {
      if (name == "input") {
        inputs.push_back(Ort::Value::CreateTensor<float>(mem, in.data(), in.size(), in_dims, 2));
      } else if (name == "sr") {
        inputs.push_back(Ort::Value::CreateTensor<int64_t>(mem, &sr_val, 1, sr_dims, 1));
      } else if (name == "h") {
        inputs.push_back(Ort::Value::CreateTensor<float>(mem, h.data(), h.size(), hc_dims, 3));
      } else if (name == "c") {
        inputs.push_back(Ort::Value::CreateTensor<float>(mem, c.data(), c.size(), hc_dims, 3));
      } else if (name == "state") {
        inputs.push_back(Ort::Value::CreateTensor<float>(mem, state.data(), state.size(), st_dims, 3));
      } else {
        // Unknown input — feed the recurrent state as a best effort.
        inputs.push_back(Ort::Value::CreateTensor<float>(mem, state.data(), state.size(), st_dims, 3));
      }
    }

    auto outputs = session.Run(
        Ort::RunOptions{nullptr}, in_c.data(), inputs.data(), inputs.size(),
        out_c.data(), out_c.size());

    float prob = 0.0f;
    for (size_t i = 0; i < output_names.size(); ++i) {
      const std::string& nm = output_names[i];
      const float* d = outputs[i].GetTensorData<float>();
      if (nm == "output") {
        prob = d[0];
        if (prob > max_prob) max_prob = prob;
      } else if (nm == "hn") {
        std::copy(d, d + h.size(), h.begin());
      } else if (nm == "cn") {
        std::copy(d, d + c.size(), c.begin());
      } else {
        // v5 new state ("stateN") or any other recurrent carry-over.
        std::copy(d, d + state.size(), state.begin());
      }
    }
    return prob;
  }
};

SileroVad::SileroVad(const std::string& model_path, int sample_rate) {
  ensureOrtApi();  // must run before any Ort:: type is constructed
  impl_ = new Impl(model_path, sample_rate);
}

SileroVad::~SileroVad() { delete impl_; }

void SileroVad::reset(const VadConfig& cfg) {
  impl_->reset();
  impl_->cfg = cfg;
  impl_->builder.reset(new VadSpanBuilder(cfg, impl_->sample_rate));
  impl_->residual.clear();
  impl_->stream_cursor = 0;
  VADLOGI("stream open: model=%s window=%d threshold=%.2f",
          impl_->v5 ? "v5(state)" : "v4(h/c)", cfg.window, cfg.threshold);
}

std::vector<Segment> SileroVad::feed(const std::string& pcm_path, int64_t from_byte,
                                     int64_t byte_count) {
  std::vector<Segment> out;
  if (!impl_->builder || byte_count <= 0) return out;

  FILE* f = std::fopen(pcm_path.c_str(), "rb");
  if (!f) return out;
  if (std::fseek(f, static_cast<long>(from_byte), SEEK_SET) != 0) {
    std::fclose(f);
    return out;
  }

  const int window = impl_->cfg.window;
  const size_t frame_bytes = static_cast<size_t>(window) * sizeof(int16_t);

  std::vector<uint8_t> raw(static_cast<size_t>(byte_count));
  const size_t got = std::fread(raw.data(), 1, raw.size(), f);
  std::fclose(f);

  // Prepend whatever did not complete a frame last time, so frame alignment never depends on
  // how the caller happened to slice the file.
  impl_->residual.insert(impl_->residual.end(), raw.begin(), raw.begin() + got);

  std::vector<float> frame(window);
  size_t off = 0;
  while (impl_->residual.size() - off >= frame_bytes) {
    for (int i = 0; i < window; ++i) {
      int16_t sample;
      std::memcpy(&sample, impl_->residual.data() + off + i * sizeof(int16_t), sizeof(int16_t));
      frame[i] = static_cast<float>(sample) / 32768.0f;
    }
    const float prob = impl_->infer(frame);
    for (const Segment& s : impl_->builder->push(prob, impl_->stream_cursor)) out.push_back(s);
    impl_->stream_cursor += window;
    off += frame_bytes;
  }
  impl_->residual.erase(impl_->residual.begin(), impl_->residual.begin() + off);
  return out;
}

std::vector<Segment> SileroVad::finish() {
  if (!impl_->builder) return {};
  const int window = impl_->cfg.window;

  std::vector<Segment> out;
  // A final short frame is zero-padded to a full window, exactly as the file path did. A trailing
  // odd byte is half a sample and is discarded, which is what reading the file whole also did.
  if (impl_->residual.size() >= sizeof(int16_t)) {
    std::vector<float> frame(window, 0.0f);
    const size_t samples = impl_->residual.size() / sizeof(int16_t);
    for (size_t i = 0; i < samples && i < static_cast<size_t>(window); ++i) {
      int16_t sample;
      std::memcpy(&sample, impl_->residual.data() + i * sizeof(int16_t), sizeof(int16_t));
      frame[i] = static_cast<float>(sample) / 32768.0f;
    }
    const float prob = impl_->infer(frame);
    out = impl_->builder->push(prob, impl_->stream_cursor);
    impl_->stream_cursor += window;
    impl_->residual.clear();
  }
  for (const Segment& s : impl_->builder->finish(impl_->stream_cursor)) out.push_back(s);
  VADLOGI("stream closed at %.1fs, peak speech prob %.3f",
          static_cast<double>(impl_->stream_cursor) / impl_->sample_rate, impl_->max_prob);
  return out;
}

int64_t SileroVad::pendingSpanStartMs() const {
  return impl_->builder ? impl_->builder->pendingSpanStartMs() : -1;
}

std::vector<Segment> SileroVad::process(const std::string& pcm_path, const VadConfig& cfg) {
  FILE* f = std::fopen(pcm_path.c_str(), "rb");
  if (!f) return {};
  std::fseek(f, 0, SEEK_END);
  const long bytes = std::ftell(f);
  std::fclose(f);
  if (bytes <= 0) return {};

  reset(cfg);
  std::vector<Segment> out = feed(pcm_path, 0, bytes);
  for (const Segment& s : finish()) out.push_back(s);
  VADLOGI("scanned %.1fs -> %zu segment(s)",
          static_cast<double>(impl_->stream_cursor) / impl_->sample_rate, out.size());
  return out;
}

}  // namespace audionotes
