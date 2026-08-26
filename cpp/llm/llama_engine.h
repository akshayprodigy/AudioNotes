// On-device text generation over llama.cpp (Qwen GGUF). Used to *enhance* the rule-based minutes.
// The model is loaded once and reused across generate() calls (map-reduce over a meeting).
#pragma once
#include <string>

namespace audionotes {

class LlamaEngine {
 public:
  LlamaEngine();
  ~LlamaEngine();

  // greedy: always take the highest-probability token, so two runs of the same input agree. A
  // judge must be greedy, because a score that moves between identical runs is not a measurement,
  // and so must the minutes, because minutes that change when you reprocess are not minutes.
  //
  // repeat_penalty: 1.0 disables it. Argmax decoding degenerates into loops on repetitive input —
  // measured emitting one transcript line forty times over — and a penalty breaks the loop while
  // staying reproducible, since it reshapes the distribution deterministically.
  //
  // Deliberately separate from `greedy` rather than implied by it: the eval judge answers twenty
  // claims per batch, mostly with the same word, and penalising repeats there would push it off
  // a correct verdict simply because it had just given the same one.
  bool load(const std::string& model_path, int n_ctx, int n_threads, bool greedy = false,
            float repeat_penalty = 1.0f);
  bool ok() const;

  // Wraps `prompt` in a ChatML user turn and generates up to max_tokens. KV cache is cleared
  // each call, so calls are independent (stateless map/reduce steps).
  std::string generate(const std::string& prompt, int max_tokens);

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace audionotes
