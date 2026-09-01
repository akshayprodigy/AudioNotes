// Which engine a language selects, and what happens when the preferred one is not installed.
// No weights needed: ok() is false throughout, but name() reports the routing decision, and the
// routing decision is the whole subject.
#include "asr/asr_engine.h"

#include <cstdio>
#include <string>

static int failures = 0;
#define CHECK(cond, ...)                                        \
  do {                                                          \
    if (!(cond)) {                                              \
      std::fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      std::fprintf(stderr, __VA_ARGS__);                        \
      std::fprintf(stderr, "\n");                               \
      ++failures;                                               \
    }                                                           \
  } while (0)

using audionotes::AsrConfig;
using audionotes::makeAsrEngine;

static std::string chose(const AsrConfig& cfg) { return makeAsrEngine(cfg)->name(); }

int main() {
  AsrConfig both;
  both.whisper_model = "/nonexistent/ggml-base-q5_1.bin";
  both.qwen3_model_dir = "/nonexistent/qwen3-asr";

  // English is whisper's: it is the international floor, 60 MB, and free-tier. So are the other
  // ~98 languages it covers — this product ships in Europe, not only India.
  { AsrConfig c = both; c.language = "en"; CHECK(chose(c) == "whisper", "en -> %s", chose(c).c_str()); }
  { AsrConfig c = both; c.language = "de"; CHECK(chose(c) == "whisper", "de -> %s", chose(c).c_str()); }
  { AsrConfig c = both; c.language = "fr"; CHECK(chose(c) == "whisper", "fr -> %s", chose(c).c_str()); }

  // Hindi routes to Qwen — but the directory above does not exist, so it must FALL BACK rather
  // than fail. A worse transcript is a product; no transcript is not.
  { AsrConfig c = both; c.language = "hi";
    CHECK(chose(c) == "whisper", "hi with no qwen installed -> %s", chose(c).c_str()); }

  // An explicit override beats the table, in both directions.
  { AsrConfig c = both; c.language = "hi"; c.engine = "whisper";
    CHECK(chose(c) == "whisper", "forced whisper -> %s", chose(c).c_str()); }
  { AsrConfig c = both; c.language = "en"; c.engine = "qwen3";
    CHECK(chose(c) == "none",
          "forced qwen with none installed must not silently give whisper, got %s",
          chose(c).c_str()); }

  // No model at all is an engine whose ok() is false, never a null pointer.
  { AsrConfig c; c.language = "en";
    auto e = makeAsrEngine(c);
    CHECK(e != nullptr, "never null");
    CHECK(!e->ok(), "no model -> not ok"); }

  { AsrConfig c = both; c.engine = "nonsense";
    CHECK(chose(c) == "none", "unknown engine name -> %s", chose(c).c_str()); }

  // The chunking contract each engine declares, which is what keeps their numbers comparable.
  { AsrConfig c = both; c.language = "en";
    auto e = makeAsrEngine(c);
    CHECK(e->maxChunkMs() == 30000, "whisper budget %lld", (long long)e->maxChunkMs());
    CHECK(e->chunkMode() == audionotes::ChunkMode::kPack, "whisper packs"); }

  if (failures == 0) std::printf("test_asr_factory OK\n");
  return failures == 0 ? 0 : 1;
}
