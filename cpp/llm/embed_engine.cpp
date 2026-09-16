#include "llm/embed_engine.h"

#include <cmath>
#include <cstdio>

#ifdef HAVE_LLAMA
#include "llama.h"
#endif

namespace audionotes {

namespace {
constexpr int kCtx = 512;
}

struct EmbedEngine::Impl {
  bool ready = false;
  int n_embd = 0;
#ifdef HAVE_LLAMA
  llama_model* model = nullptr;
  llama_context* ctx = nullptr;
  const llama_vocab* vocab = nullptr;

  bool load(const std::string& path, int n_threads) {
    llama_backend_init();
    llama_model_params mparams = llama_model_default_params();
    model = llama_model_load_from_file(path.c_str(), mparams);
    if (!model) return false;
    vocab = llama_model_get_vocab(model);

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = kCtx;
    // Non-causal (BERT) attention wants the physical batch equal to the logical one: a text is
    // one forward pass, never split. Pooling is whatever the GGUF declares — CLS for bge, mean
    // for MiniLM — and a model that declares none is refused rather than guessed at, because a
    // guess would embed every phone's library differently from the Mac that tested it.
    cparams.n_batch = kCtx;
    cparams.n_ubatch = kCtx;
    cparams.n_threads = n_threads;
    cparams.n_threads_batch = n_threads;
    cparams.embeddings = true;
    cparams.pooling_type = LLAMA_POOLING_TYPE_UNSPECIFIED;
    ctx = llama_init_from_model(model, cparams);
    if (!ctx) return false;
    if (llama_pooling_type(ctx) == LLAMA_POOLING_TYPE_NONE) {
      std::fprintf(stderr, "embed: model declares no pooling; refusing to guess\n");
      return false;
    }
    n_embd = llama_model_n_embd(model);
    ready = n_embd > 0;
    return ready;
  }

  std::vector<float> one(const std::string& text) {
    // add_special: bge expects [CLS] … [SEP] around the words. A text past the context keeps
    // its first kCtx tokens (llama_tokenize reports the overflow as a negative count).
    std::vector<llama_token> toks(static_cast<size_t>(kCtx));
    int n = llama_tokenize(vocab, text.c_str(), static_cast<int32_t>(text.size()), toks.data(),
                           kCtx, /*add_special=*/true, /*parse_special=*/false);
    if (n < 0) n = kCtx;
    if (n == 0) return {};
    toks.resize(static_cast<size_t>(n));

    llama_batch batch = llama_batch_init(n, 0, 1);
    for (int i = 0; i < n; ++i) {
      batch.token[i] = toks[static_cast<size_t>(i)];
      batch.pos[i] = i;
      batch.n_seq_id[i] = 1;
      batch.seq_id[i][0] = 0;
      batch.logits[i] = 1;
    }
    batch.n_tokens = n;
    llama_memory_clear(llama_get_memory(ctx), true);
    std::vector<float> out;
    if (llama_decode(ctx, batch) == 0) {
      const float* e = llama_get_embeddings_seq(ctx, 0);
      if (e) {
        out.assign(e, e + n_embd);
        float norm = 0;
        for (float x : out) norm += x * x;
        norm = std::sqrt(norm);
        if (norm > 0) {
          for (float& x : out) x /= norm;
        }
      }
    }
    llama_batch_free(batch);
    return out;
  }

  ~Impl() {
    if (ctx) llama_free(ctx);
    if (model) llama_model_free(model);
  }
#else
  bool load(const std::string&, int) { return false; }
  std::vector<float> one(const std::string&) { return {}; }
#endif
};

EmbedEngine::EmbedEngine() : impl_(new Impl()) {}
EmbedEngine::~EmbedEngine() { delete impl_; }

bool EmbedEngine::load(const std::string& model_path, int n_threads) {
  return impl_->load(model_path, n_threads < 1 ? 1 : n_threads);
}
bool EmbedEngine::ok() const { return impl_->ready; }
int EmbedEngine::dim() const { return impl_->n_embd; }

std::vector<std::vector<float>> EmbedEngine::embed(const std::vector<std::string>& texts) {
  std::vector<std::vector<float>> out;
  if (!impl_->ready) return out;
  out.reserve(texts.size());
  for (const auto& t : texts) out.push_back(impl_->one(t));
  return out;
}

}  // namespace audionotes
