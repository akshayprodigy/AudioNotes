#include "llm/llama_engine.h"

#include <cstdio>

#include "util/utf8.h"

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
  float repeat_penalty_cached = 1.0f;
  int n_ctx_cached = 0;
#endif

  bool load(const std::string& path, int n_ctx, int n_threads, bool greedy,
            float repeat_penalty) {
#ifdef HAVE_LLAMA
    llama_backend_init();

    llama_model_params mparams = llama_model_default_params();
    model = llama_model_load_from_file(path.c_str(), mparams);
    if (!model) return false;
    vocab = llama_model_get_vocab(model);

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = n_ctx;
    // A whole prompt is decoded in ONE llama_decode call, so the logical batch must be able to
    // hold it. llama.cpp defaults n_batch to 2048 and asserts (aborts the process) when a batch
    // exceeds it — a 6000-char map chunk is already ~1500 tokens, so the shipped path was one
    // long meeting away from the same crash the eval judge hit.
    cparams.n_batch = static_cast<uint32_t>(n_ctx);
    n_ctx_cached = n_ctx;
    cparams.n_threads = n_threads;
    cparams.n_threads_batch = n_threads;
    ctx = llama_init_from_model(model, cparams);
    if (!ctx) return false;

    repeat_penalty_cached = repeat_penalty;
    smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
    if (greedy) {
      // Argmax alone degenerates. Measured 2026-08-26 on the real NeoSym recording: greedy
      // decoding over a repetitive meeting transcript emitted "- Speaker 2: \"I'll do it.\""
      // forty times until it hit the token limit, and the minutes built on those notes were
      // worthless. A repetition penalty breaks the loop while keeping the run reproducible —
      // it reshapes the distribution deterministically, and argmax over it is still argmax.
      //
      // 1.15 over the last 256 tokens is enough to escape a loop without suppressing the
      // legitimate repetition of a speaker's name down a list of action items.
      if (repeat_penalty > 1.0f) {
        llama_sampler_chain_add(smpl, llama_sampler_init_penalties(
                                          /*penalty_last_n=*/256, repeat_penalty,
                                          /*penalty_freq=*/0.0f, /*penalty_present=*/0.0f));
      }
      llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
    } else {
      llama_sampler_chain_add(smpl, llama_sampler_init_top_k(40));
      llama_sampler_chain_add(smpl, llama_sampler_init_top_p(0.95f, 1));
      llama_sampler_chain_add(smpl, llama_sampler_init_temp(0.3f));  // low temp: factual, stable
      llama_sampler_chain_add(smpl, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));
    }

    ready = true;
    return true;
#else
    (void)path;
    (void)greedy;
    (void)repeat_penalty;
    (void)n_ctx;
    (void)n_threads;
    return false;
#endif
  }

  std::string generate(const std::string& prompt, int max_tokens) {
#ifdef HAVE_LLAMA
    return run(prompt, max_tokens, smpl);
#else
    (void)prompt;
    (void)max_tokens;
    return "";
#endif
  }

  std::string generateConstrained(const std::string& prompt, int max_tokens,
                                  const std::string& grammar) {
#ifdef HAVE_LLAMA
    if (!ready) return "";
    llama_sampler* g = llama_sampler_init_grammar(vocab, grammar.c_str(), "root");
    if (!g) {
      std::fprintf(stderr, "llama: grammar failed to parse — constrained generation skipped\n");
      return "";
    }
    // Grammar first, greedy after: the grammar masks, greedy picks among what is left.
    llama_sampler* chain = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(chain, g);
    if (repeat_penalty_cached > 1.0f) {
      llama_sampler_chain_add(chain, llama_sampler_init_penalties(256, repeat_penalty_cached, 0.0f, 0.0f));
    }
    llama_sampler_chain_add(chain, llama_sampler_init_greedy());
    const std::string out = run(prompt, max_tokens, chain);
    llama_sampler_free(chain);  // frees the grammar sampler with it
    return out;
#else
    (void)prompt;
    (void)max_tokens;
    (void)grammar;
    return "";
#endif
  }

#ifdef HAVE_LLAMA
  // One decode loop for both samplers: the loaded chain, or a per-call constrained one.
  std::string run(const std::string& prompt, int max_tokens, llama_sampler* sampler) {
    std::string out;
    if (!ready || !sampler) return out;

    // Independent calls: clear the KV cache so token positions reset each generation.
    // Map/reduce summarisation issues many unrelated generations against one loaded model;
    // without this each one would continue the previous context and drift.
    //
    // API note: this was llama_kv_self_clear(ctx) until llama.cpp moved cache control behind
    // the memory API. Pinned at tag b10240 — if you bump the submodule and this stops
    // compiling, the replacement is whatever llama.h now exposes under "Memory".
    llama_memory_clear(llama_get_memory(ctx), /*data=*/true);

    const std::string text =
        "<|im_start|>user\n" + prompt + "<|im_end|>\n<|im_start|>assistant\n";

    const int32_t n_prompt = -llama_tokenize(
        vocab, text.c_str(), static_cast<int32_t>(text.size()), nullptr, 0, true, true);
    std::vector<llama_token> tokens(n_prompt);
    if (llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()),
                       tokens.data(), static_cast<int32_t>(tokens.size()), true, true) < 0) {
      return out;
    }

    // Belt and braces: llama_decode ABORTS the process on an over-long batch rather than
    // returning an error, and losing a whole meeting to a long prompt is not an acceptable
    // failure. An empty result is; callers already treat it as "no enhancement".
    if (static_cast<int>(tokens.size()) >= n_ctx_cached) {
      std::fprintf(stderr, "llama: prompt is %zu tokens, over the %d-token context — skipping\n",
                   tokens.size(), n_ctx_cached);
      return out;
    }

    llama_batch batch = llama_batch_get_one(tokens.data(), static_cast<int32_t>(tokens.size()));
    llama_token cur = 0;
    int decoded = 0;
    while (decoded < max_tokens) {
      if (llama_decode(ctx, batch) != 0) break;
      cur = llama_sampler_sample(sampler, ctx, -1);
      if (llama_vocab_is_eog(vocab, cur)) break;

      char buf[512];
      int n = llama_token_to_piece(vocab, cur, buf, sizeof(buf), 0, true);
      if (n > 0) out.append(buf, n);

      batch = llama_batch_get_one(&cur, 1);
      decoded++;
    }
    // Generation that stops mid-character (max_tokens, or EOG right after a partial piece)
    // leaves a trailing fragment. Sanitize the FINISHED string, never the individual pieces: a
    // BPE token is routinely half a character, so per-piece scrubbing would delete every
    // non-ASCII character in the output.
    return sanitizeUtf8(out);
  }
#endif

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

bool LlamaEngine::load(const std::string& model_path, int n_ctx, int n_threads,
                       bool greedy, float repeat_penalty) {
  return impl_->load(model_path, n_ctx, n_threads, greedy, repeat_penalty);
}

std::string LlamaEngine::generate(const std::string& prompt, int max_tokens) {
  return impl_->generate(prompt, max_tokens);
}

std::string LlamaEngine::generateConstrained(const std::string& prompt, int max_tokens,
                                             const std::string& grammar) {
  return impl_->generateConstrained(prompt, max_tokens, grammar);
}

}  // namespace audionotes
