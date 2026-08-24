// On-device text generation over llama.cpp (Qwen GGUF). Used to *enhance* the rule-based minutes.
// The model is loaded once and reused across generate() calls (map-reduce over a meeting).
#pragma once
#include <string>

namespace audionotes {

class LlamaEngine {
 public:
  LlamaEngine();
  ~LlamaEngine();

  // greedy: always take the highest-probability token. The shipped path wants a little
  // variation and uses a seeded low-temperature chain; a judge must not, because a score that
  // moves between identical runs is not a measurement.
  bool load(const std::string& model_path, int n_ctx, int n_threads, bool greedy = false);
  bool ok() const;

  // Wraps `prompt` in a ChatML user turn and generates up to max_tokens. KV cache is cleared
  // each call, so calls are independent (stateless map/reduce steps).
  std::string generate(const std::string& prompt, int max_tokens);

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace audionotes
