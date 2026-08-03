#include "llm/llama_engine.h"

#include <string>
#include <vector>

#ifdef HAVE_LLAMA
#include "llama.h"
#endif

// NOTE: llama.cpp's API moves quickly. This targets a recent (2025) release using
// llama_model_load_from_file / llama_init_from_model / the llama_sampler chain API. If you pin an
// older commit, adjust the symbol names (e.g. kv-cache clear) to match that version.

namespace audionotes {

struct LlamaEngine::Impl {
  bool ready = false;
#ifdef HAVE_LLAMA
  llama_model* model = nullptr;
  llama_context* ctx = nullptr;
  const llama_vocab* vocab = nullptr;
  llama_sampler* smpl = nullptr;
#endif

  bool load(const std::string& path, int n_ctx, int n_threads) {
#ifdef HAVE_LLAMA
    llama_backend_init();

    llama_model_params mparams = llama_model_default_params();
    model = llama_model_load_from_file(path.c_str(), mparams);
    if (!model) return false;
    vocab = llama_model_get_vocab(model);

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = n_ctx;
    cparams.n_threads = n_threads;
    cparams.n_threads_batch = n_threads;
    ctx = llama_init_from_model(model, cparams);
    if (!ctx) return false;

    smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(smpl, llama_sampler_init_top_k(40));
    llama_sampler_chain_add(smpl, llama_sampler_init_top_p(0.95f, 1));
    llama_sampler_chain_add(smpl, llama_sampler_init_temp(0.3f));  // low temp: factual, stable
    llama_sampler_chain_add(smpl, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));

    ready = true;
    return true;
#else
    (void)path;
    (void)n_ctx;
    (void)n_threads;
    return false;
#endif
  }

  std::string generate(const std::string& prompt, int max_tokens) {
    std::string out;
#ifdef HAVE_LLAMA
    if (!ready) return out;

    // Independent calls: clear the KV cache so positions reset each generation.
    llama_kv_self_clear(ctx);

    const std::string text =
        "<|im_start|>user\n" + prompt + "<|im_end|>\n<|im_start|>assistant\n";

    const int32_t n_prompt = -llama_tokenize(
        vocab, text.c_str(), static_cast<int32_t>(text.size()), nullptr, 0, true, true);
    std::vector<llama_token> tokens(n_prompt);
    if (llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()),
                       tokens.data(), static_cast<int32_t>(tokens.size()), true, true) < 0) {
      return out;
    }

    llama_batch batch = llama_batch_get_one(tokens.data(), static_cast<int32_t>(tokens.size()));
    llama_token cur = 0;
    int decoded = 0;
    while (decoded < max_tokens) {
      if (llama_decode(ctx, batch) != 0) break;
      cur = llama_sampler_sample(smpl, ctx, -1);
      if (llama_vocab_is_eog(vocab, cur)) break;

      char buf[512];
      int n = llama_token_to_piece(vocab, cur, buf, sizeof(buf), 0, true);
      if (n > 0) out.append(buf, n);

      batch = llama_batch_get_one(&cur, 1);
      decoded++;
    }
#else
    (void)prompt;
    (void)max_tokens;
#endif
    return out;
  }

  ~Impl() {
#ifdef HAVE_LLAMA
    if (smpl) llama_sampler_free(smpl);
    if (ctx) llama_free(ctx);
    if (model) llama_model_free(model);
    llama_backend_free();
#endif
  }
};

LlamaEngine::LlamaEngine() : impl_(new Impl()) {}
LlamaEngine::~LlamaEngine() { delete impl_; }
bool LlamaEngine::ok() const { return impl_->ready; }

bool LlamaEngine::load(const std::string& model_path, int n_ctx, int n_threads) {
  return impl_->load(model_path, n_ctx, n_threads);
}

std::string LlamaEngine::generate(const std::string& prompt, int max_tokens) {
  return impl_->generate(prompt, max_tokens);
}

}  // namespace audionotes
