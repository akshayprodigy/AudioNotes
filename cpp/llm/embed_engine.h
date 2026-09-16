// Sentence embeddings over llama.cpp (a BERT-family GGUF such as bge-small-en-v1.5). The model
// is loaded once and reused; every call is independent. Used by meaning search and by Ask's
// retrieval. Vectors come back L2-normalised, so a dot product is a cosine.
#pragma once
#include <string>
#include <vector>

namespace audionotes {

class EmbedEngine {
 public:
  EmbedEngine();
  ~EmbedEngine();
  EmbedEngine(const EmbedEngine&) = delete;
  EmbedEngine& operator=(const EmbedEngine&) = delete;

  // The context is fixed at 512 tokens — bge's own limit. A text longer than that is truncated
  // at the tokenizer, never refused: a chunk is at most a hundred words by construction
  // (SearchChunker), so this only ever bounds a hand-typed question.
  bool load(const std::string& model_path, int n_threads);
  bool ok() const;
  int dim() const;

  // One vector per text, in order. Empty input → empty output; an empty text still embeds. A
  // text the model could not embed (decode failure) comes back as an empty vector.
  std::vector<std::vector<float>> embed(const std::vector<std::string>& texts);

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace audionotes
