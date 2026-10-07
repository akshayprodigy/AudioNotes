// Measurement tool, not a test (not in any CMake target): embeds each line of a UTF-8 text file
// with the same EmbedEngine the app uses and prints one line of 384 space-separated floats per
// input line. eval/measure_search_floor.py builds and drives it.
//   embed_dump <model.gguf> <lines.txt>  >  vectors.txt
#include "llm/embed_engine.h"

#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

using namespace audionotes;

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: embed_dump <model.gguf> <lines.txt>\n");
    return 2;
  }
  EmbedEngine e;
  if (!e.load(argv[1], 4)) {
    std::fprintf(stderr, "embed_dump: could not load %s\n", argv[1]);
    return 1;
  }
  std::ifstream in(argv[2]);
  std::vector<std::string> lines;
  for (std::string l; std::getline(in, l);) lines.push_back(l);
  for (size_t i = 0; i < lines.size(); i += 16) {
    const std::vector<std::string> batch(lines.begin() + i, lines.begin() + std::min(lines.size(), i + 16));
    for (const auto& v : e.embed(batch)) {
      for (size_t k = 0; k < v.size(); ++k) std::printf(k ? " %.6f" : "%.6f", v[k]);
      std::printf("\n");
    }
  }
  return 0;
}
