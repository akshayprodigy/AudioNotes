// The embedding engine, against the real model on the Mac. Skipped — with a printed reason and
// exit 0 — when VERBALE_EMBED_GGUF is unset or names a missing file, so the gate passes on a
// machine without the weights and fails loudly on one with them. The phone's copy of this is
// NativePipelineTest.embedding_is_a_unit_vector.
#include "llm/embed_engine.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

using namespace audionotes;

// Not assert(): this target is built Release, where NDEBUG compiles every assert away.
static int failures = 0;
#define CHECK(cond)                                                        \
  do {                                                                     \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                          \
    }                                                                      \
  } while (0)

static float dot(const std::vector<float>& a, const std::vector<float>& b) {
  float s = 0;
  for (size_t i = 0; i < a.size() && i < b.size(); ++i) s += a[i] * b[i];
  return s;
}

int main() {
  const char* path = std::getenv("VERBALE_EMBED_GGUF");
  if (!path || !*path) {
    std::puts("test_embed: skipped (VERBALE_EMBED_GGUF unset)");
    return 0;
  }
  if (FILE* f = std::fopen(path, "rb")) {
    std::fclose(f);
  } else {
    std::printf("test_embed: skipped (%s not found)\n", path);
    return 0;
  }

  EmbedEngine e;
  CHECK(!e.ok());
  CHECK(e.embed({"before load"}).empty());
  if (!e.load(path, 4)) {
    std::fprintf(stderr, "test_embed: could not load %s\n", path);
    return 1;
  }
  CHECK(e.ok());
  CHECK(e.dim() == 384);

  const auto v = e.embed({"the proposal is due on Friday", "when do we deliver the pitch",
                          "the coffee machine is broken"});
  CHECK(v.size() == 3);
  for (const auto& x : v) {
    CHECK(x.size() == 384);
    CHECK(std::fabs(dot(x, x) - 1.0f) < 1e-3f);  // unit length
  }
  const float near = dot(v[0], v[1]);
  const float far = dot(v[0], v[2]);
  std::printf("test_embed: near=%.3f far=%.3f\n", near, far);
  CHECK(near > far + 0.1f);

  // Deterministic: the same words embed to the same vector, whatever came before.
  const auto again = e.embed({"the proposal is due on Friday"});
  CHECK(again.size() == 1 && std::fabs(dot(again[0], v[0]) - 1.0f) < 1e-4f);

  // Empty input is not an error; an empty string still yields a vector ([CLS] [SEP] alone).
  CHECK(e.embed({}).empty());
  const auto blank = e.embed({""});
  CHECK(blank.size() == 1 && blank[0].size() == 384);

  // A text far past the context is truncated, not refused.
  std::string longText;
  for (int i = 0; i < 2000; ++i) longText += "word ";
  const auto lt = e.embed({longText});
  CHECK(lt.size() == 1 && lt[0].size() == 384);

  // The eight pairs of the Phase 3 (thread memory) brief §4, measured on this same model — what
  // chose DecisionLinks.LINK_COSINE (0.72) and LINK_COSINE_WITH_WORD (0.60). The phone's mirror of
  // this is NativePipelineTest (device, printed rather than asserted — the brief records what it
  // measures instead of pinning a device-specific float). Four "yes" pairs at >= 0.69, four "no"
  // pairs at <= 0.66; a mutant that swapped a "yes" sentence for a "no" one must fail this.
  struct Pair { const char* a; const char* b; bool shouldLink; };
  const Pair pairs[] = {
      {"The proposal goes out Friday.",
       "The proposal will be sent next week instead of Friday.", true},
      {"We will use Postgres for the new service.",
       "We decided to switch the new service from Postgres to SQLite.", true},
      {"We will ship on Monday.",
       "Shipping moved to Thursday because QA is not done.", true},
      {"Existing vendors keep their old codes.",
       "We will not migrate the old codes.", true},
      {"Shipping moved to Thursday because QA is not done.",
       "The proposal will be sent next week instead of Friday.", false},
      {"We will ship on Monday.", "The proposal goes out Friday.", false},
      {"The proposal goes out Friday.", "Lunch will be at one.", false},
      {"We will ship on Monday.", "We agreed to hire two more testers.", false},
  };
  for (const auto& p : pairs) {
    const auto pv = e.embed({p.a, p.b});
    CHECK(pv.size() == 2);
    const float c = dot(pv[0], pv[1]);
    std::printf("test_embed: pair cosine=%.3f shouldLink=%d :: \"%s\" <-> \"%s\"\n", c,
                p.shouldLink, p.a, p.b);
    if (p.shouldLink) {
      CHECK(c >= 0.69f);
    } else {
      CHECK(c <= 0.66f);
    }
  }

  if (failures) {
    std::fprintf(stderr, "test_embed: %d failure(s)\n", failures);
    return 1;
  }
  std::puts("test_embed: ok");
  return 0;
}
