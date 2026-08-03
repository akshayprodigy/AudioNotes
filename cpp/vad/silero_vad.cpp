#include "vad/silero_vad.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <dlfcn.h>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

// Manual init: don't reference OrtGetApiBase from the header, so we don't link libonnxruntime.so
// at build time. We resolve it at runtime via dlopen (the .so is shipped by the onnxruntime-android
// AAR and packaged in the APK). This removes the need for a prefab CMake config / find_package.
#define ORT_API_MANUAL_INIT
#include "onnxruntime_cxx_api.h"

namespace audionotes {

namespace {
// Load libonnxruntime.so once and hand its OrtApi to the C++ wrapper.
void ensureOrtApi() {
  static std::once_flag once;
  std::call_once(once, [] {
    void* h = dlopen("libonnxruntime.so", RTLD_NOW | RTLD_GLOBAL);
    if (!h) throw std::runtime_error(std::string("dlopen libonnxruntime.so failed: ") + dlerror());
    using GetApiBaseFn = const OrtApiBase* (*)();
    auto get_base = reinterpret_cast<GetApiBaseFn>(dlsym(h, "OrtGetApiBase"));
    if (!get_base) throw std::runtime_error("OrtGetApiBase not found in libonnxruntime.so");
    const OrtApi* api = get_base()->GetApi(ORT_API_VERSION);
    if (!api) throw std::runtime_error("OrtGetApiBase()->GetApi returned null");
    Ort::InitApi(api);
  });
}
}  // namespace

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

  Impl(const std::string& model_path, int sr)
      : sample_rate(sr),
        env(ORT_LOGGING_LEVEL_WARNING, "audionotes-vad"),
        opts(),
        session(nullptr),
        mem(Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault)),
        sr_val(sr),
        h(2 * 1 * 64, 0.0f),
        c(2 * 1 * 64, 0.0f),
        state(2 * 1 * 128, 0.0f) {
    opts.SetIntraOpNumThreads(1);
    opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
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
  }

  // Run one frame; returns speech probability and advances the recurrent state.
  // Works for both Silero v4 (input/sr/h/c -> output/hn/cn) and v5 (input/state/sr -> output/stateN).
  float infer(std::vector<float>& frame) {
    const int64_t in_dims[2] = {1, static_cast<int64_t>(frame.size())};
    const int64_t sr_dims[1] = {1};
    const int64_t hc_dims[3] = {2, 1, 64};
    const int64_t st_dims[3] = {2, 1, 128};

    std::vector<Ort::Value> inputs;
    inputs.reserve(input_names.size());
    for (const auto& name : input_names) {
      if (name == "input") {
        inputs.push_back(Ort::Value::CreateTensor<float>(mem, frame.data(), frame.size(), in_dims, 2));
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

std::vector<Segment> SileroVad::process(const std::string& pcm_path, const VadConfig& cfg) {
  std::vector<Segment> out;
  FILE* f = std::fopen(pcm_path.c_str(), "rb");
  if (!f) return out;

  const int sr = impl_->sample_rate;
  const int window = cfg.window;
  const float neg_threshold = cfg.threshold - 0.15f;
  const int64_t min_speech = static_cast<int64_t>(cfg.min_speech_ms) * sr / 1000;
  const int64_t min_silence = static_cast<int64_t>(cfg.min_silence_ms) * sr / 1000;
  const int64_t pad = static_cast<int64_t>(cfg.speech_pad_ms) * sr / 1000;

  impl_->reset();

  std::vector<int16_t> raw(window);
  std::vector<float> frame(window);
  std::vector<std::pair<int64_t, int64_t>> spans;  // in samples

  bool triggered = false;
  int64_t temp_end = 0;
  int64_t speech_start = 0;
  int64_t cursor = 0;  // sample index at the start of the current frame

  while (true) {
    size_t got = std::fread(raw.data(), sizeof(int16_t), window, f);
    if (got == 0) break;
    for (size_t i = 0; i < static_cast<size_t>(window); ++i) {
      frame[i] = (i < got) ? static_cast<float>(raw[i]) / 32768.0f : 0.0f;
    }

    const float prob = impl_->infer(frame);
    const int64_t frame_start = cursor;
    cursor += window;

    if (prob >= cfg.threshold && temp_end != 0) temp_end = 0;
    if (prob >= cfg.threshold && !triggered) {
      triggered = true;
      speech_start = frame_start;
    } else if (prob < neg_threshold && triggered) {
      if (temp_end == 0) temp_end = frame_start;
      if (cursor - temp_end >= min_silence) {
        if (temp_end - speech_start > min_speech) spans.emplace_back(speech_start, temp_end);
        triggered = false;
        temp_end = 0;
      }
    }
    if (got < static_cast<size_t>(window)) break;  // last (short) frame
  }
  std::fclose(f);

  if (triggered && cursor - speech_start > min_speech) spans.emplace_back(speech_start, cursor);

  // Pad, clamp, merge overlaps, convert samples -> ms.
  const int64_t total = cursor;
  for (auto& s : spans) {
    s.first = std::max<int64_t>(0, s.first - pad);
    s.second = std::min<int64_t>(total, s.second + pad);
  }
  for (const auto& s : spans) {
    if (!out.empty() && s.first * 1000 / sr <= out.back().end_ms) {
      out.back().end_ms = std::max(out.back().end_ms, s.second * 1000 / sr);
    } else {
      out.push_back(Segment{s.first * 1000 / sr, s.second * 1000 / sr});
    }
  }
  return out;
}

}  // namespace audionotes
