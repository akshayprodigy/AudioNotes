#include "pipeline/pipeline.h"

#include <cstdio>

static int failures = 0;
#define CHECK(cond, ...)                                   \
  do {                                                     \
    if (!(cond)) {                                         \
      std::fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      std::fprintf(stderr, __VA_ARGS__);                   \
      std::fprintf(stderr, "\n");                          \
      ++failures;                                          \
    }                                                      \
  } while (0)

int main() {
  using audionotes::DiarSegment;
  using audionotes::Utterance;

  // The shipped default. `auto` re-detects the language every chunk, which is what returned one
  // meeting in five scripts including Korean and Chinese. Pinned so it cannot drift back.
  {
    audionotes::PipelineConfig cfg;
    CHECK(cfg.language == "en", "default language is '%s', want 'en'", cfg.language.c_str());
  }

  // Utterance A overlaps cluster 0 for 800ms and cluster 1 for 200ms -> 0.
  // Utterance B overlaps only cluster 1 -> 1. Utterance C overlaps nothing -> -1.
  std::vector<Utterance> utts = {
      {0, 1000, "A"}, {1500, 2500, "B"}, {5000, 6000, "C"}};
  std::vector<DiarSegment> diar = {
      {0, 800, 0}, {800, 1000, 1}, {1400, 2600, 1}};
  auto aligned = audionotes::alignSpeakers(utts, diar);
  CHECK(aligned.size() == 3, "size %zu", aligned.size());
  CHECK(aligned[0].speaker == 0, "A -> %d, want 0", aligned[0].speaker);
  CHECK(aligned[1].speaker == 1, "B -> %d, want 1", aligned[1].speaker);
  CHECK(aligned[2].speaker == -1, "C -> %d, want -1", aligned[2].speaker);
  CHECK(aligned[0].text == "A" && aligned[0].start_ms == 0 && aligned[0].end_ms == 1000,
        "fields carried");

  // Summed overlap across split segments of the same cluster must win:
  // cluster 2 covers [0,300)+[700,1000) = 600ms vs cluster 3's [300,700) = 400ms.
  std::vector<DiarSegment> split = {{0, 300, 2}, {300, 700, 3}, {700, 1000, 2}};
  auto a2 = audionotes::alignSpeakers({{0, 1000, "X"}}, split);
  CHECK(a2[0].speaker == 2, "summed overlap -> %d, want 2", a2[0].speaker);

  // speakerNames: clusters {2, 0} in use -> "Speaker 1" for 0, "Speaker 2" for 2 (ascending).
  auto names = audionotes::speakerNames(
      {{0, 1, 2, "x"}, {1, 2, 0, "y"}, {2, 3, -1, "z"}});
  CHECK(names.size() == 2, "names size %zu", names.size());
  CHECK(names[0].id == "S0" && names[0].display_name == "Speaker 1", "names[0] %s=%s",
        names[0].id.c_str(), names[0].display_name.c_str());
  CHECK(names[1].id == "S2" && names[1].display_name == "Speaker 2", "names[1] %s=%s",
        names[1].id.c_str(), names[1].display_name.c_str());

  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_pipeline_align OK\n");
  return 0;
}
