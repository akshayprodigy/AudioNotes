// A GGUF prompted from the command line, used by the eval harness as an LLM judge.
//
// Batch by construction: loading a 7B model takes seconds and a meeting produces dozens of
// judgements, so prompts arrive together on stdin separated by a %%PROMPT%% line and the model
// loads once. Greedy sampling, because a score that moves between identical runs is not a
// measurement.
#include "llm/llama_engine.h"

#include <cstdio>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {
const char* kSep = "%%PROMPT%%";
const char* kEnd = "%%END%%";
}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr,
                 "usage: %s <model.gguf> [--ctx N] [--threads N] [--max-tokens N] [--repeat-penalty F]\n"
                 "  prompts on stdin, separated by a line containing %s\n"
                 "  one completion per prompt on stdout, each terminated by %s\n",
                 argv[0], kSep, kEnd);
    return 2;
  }
  const std::string model = argv[1];
  int n_ctx = 8192, threads = 0, max_tokens = 192;
  // Default 1.0 (off). The judge answers many claims per batch, mostly with the same word, so
  // penalising repeats would push it off a correct verdict simply for having just given it. The
  // flag exists so the minutes prompts can be measured under the settings they actually ship with.
  float repeat_penalty = 1.0f;
  for (int i = 2; i < argc; ++i) {
    if (std::strcmp(argv[i], "--ctx") == 0 && i + 1 < argc) n_ctx = std::atoi(argv[++i]);
    else if (std::strcmp(argv[i], "--threads") == 0 && i + 1 < argc) threads = std::atoi(argv[++i]);
    else if (std::strcmp(argv[i], "--max-tokens") == 0 && i + 1 < argc) max_tokens = std::atoi(argv[++i]);
    else if (std::strcmp(argv[i], "--repeat-penalty") == 0 && i + 1 < argc) repeat_penalty = static_cast<float>(std::atof(argv[++i]));
  }

  std::vector<std::string> prompts;
  {
    std::string line, current;
    bool any = false;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line == kSep) {
        prompts.push_back(current);
        current.clear();
        any = true;
        continue;
      }
      current += line;
      current += "\n";
      any = true;
    }
    if (any) prompts.push_back(current);
  }
  if (prompts.empty()) {
    std::fprintf(stderr, "no prompts on stdin\n");
    return 2;
  }

  audionotes::LlamaEngine engine;
  if (!engine.load(model, n_ctx, threads, /*greedy=*/true, repeat_penalty)) {
    std::fprintf(stderr, "failed to load %s\n", model.c_str());
    return 1;
  }
  for (const std::string& p : prompts) {
    std::string out = engine.generate(p, max_tokens);
    std::fwrite(out.data(), 1, out.size(), stdout);
    std::printf("\n%s\n", kEnd);
    std::fflush(stdout);   // so a caller can stream, and a crash mid-batch loses only the tail
  }
  return 0;
}
