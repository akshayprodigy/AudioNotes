// The VAD's span logic, fed synthetic probabilities so it can be tested without a model.
// This is where the live path and the file path must agree, and where a padding or merge slip
// would silently shift every chunk boundary and cost every cache hit.
#include "vad/vad_span_builder.h"

#include <cstdio>
#include <utility>
#include <vector>

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

using audionotes::Segment;
using audionotes::VadConfig;
using audionotes::VadSpanBuilder;

static const int kSr = 16000;
static const int kWindow = 512;  // 32 ms per frame at 16 kHz

// Drive the builder with a run-length script of (speech?, frame count).
static std::vector<Segment> run(const std::vector<std::pair<bool, int>>& script) {
  VadSpanBuilder b(VadConfig{}, kSr);
  std::vector<Segment> out;
  int64_t cursor = 0;
  for (const auto& part : script) {
    for (int i = 0; i < part.second; ++i) {
      for (const Segment& s : b.push(part.first ? 0.9f : 0.0f, cursor)) out.push_back(s);
      cursor += kWindow;
    }
  }
  for (const Segment& s : b.finish(cursor)) out.push_back(s);
  return out;
}

int main() {
  // Silence only.
  CHECK(run({{false, 100}}).empty(), "silence produces no spans");

  // A blip shorter than min_speech_ms (250 ms = ~8 frames) is dropped.
  CHECK(run({{false, 10}, {true, 3}, {false, 30}}).empty(), "sub-250ms blip dropped");

  // A real span: 40 frames of speech (1280 ms), padded 30 ms each side.
  {
    const std::vector<Segment> got = run({{false, 10}, {true, 40}, {false, 30}});
    CHECK(got.size() == 1, "one span, got %zu", got.size());
    if (got.size() == 1) {
      // Speech starts at frame 10 = 5120 samples = 320 ms, minus 30 ms of padding.
      CHECK(got[0].start_ms == 290, "start_ms %lld, want 290", (long long)got[0].start_ms);
      CHECK(got[0].end_ms > got[0].start_ms, "end after start");
    }
  }

  // A span still open when the audio ends is flushed by finish().
  {
    const std::vector<Segment> got = run({{false, 5}, {true, 40}});
    CHECK(got.size() == 1, "open span flushed at finish, got %zu", got.size());
  }

  // Nothing pending in pure silence; a start is reported while speech is in progress.
  {
    VadSpanBuilder b(VadConfig{}, kSr);
    int64_t cursor = 0;
    for (int i = 0; i < 10; ++i) { b.push(0.0f, cursor); cursor += kWindow; }
    CHECK(b.pendingSpanStartMs() == -1, "nothing pending during silence");
    for (int i = 0; i < 10; ++i) { b.push(0.9f, cursor); cursor += kWindow; }
    CHECK(b.pendingSpanStartMs() == 290, "pending start %lld, want 290",
          (long long)b.pendingSpanStartMs());
  }

  // A span already CLOSED but held back must still be reported as pending: it is invisible to
  // the caller and can still be packed into the previous decode window.
  {
    VadSpanBuilder b(VadConfig{}, kSr);
    int64_t cursor = 0;
    std::vector<Segment> released;
    for (const auto& part : std::vector<std::pair<bool, int>>{{false, 10}, {true, 40}, {false, 30}}) {
      for (int i = 0; i < part.second; ++i) {
        for (const Segment& s : b.push(part.first ? 0.9f : 0.0f, cursor)) released.push_back(s);
        cursor += kWindow;
      }
    }
    CHECK(released.empty(), "the first span is held, not released (%zu released)", released.size());
    CHECK(b.pendingSpanStartMs() == 290, "held span reported as pending, got %lld",
          (long long)b.pendingSpanStartMs());
  }

  // Feeding the same script in two halves must give the same spans as feeding it whole —
  // this is the property the live path depends on.
  {
    const std::vector<Segment> whole = run({{false, 10}, {true, 40}, {false, 60}, {true, 40},
                                            {false, 30}});
    VadSpanBuilder b(VadConfig{}, kSr);
    std::vector<Segment> split;
    int64_t cursor = 0;
    const std::vector<std::pair<bool, int>> first = {{false, 10}, {true, 40}, {false, 20}};
    const std::vector<std::pair<bool, int>> second = {{false, 40}, {true, 40}, {false, 30}};
    for (const auto& part : {first, second}) {
      for (const auto& p : part) {
        for (int i = 0; i < p.second; ++i) {
          for (const Segment& s : b.push(p.first ? 0.9f : 0.0f, cursor)) split.push_back(s);
          cursor += kWindow;
        }
      }
    }
    for (const Segment& s : b.finish(cursor)) split.push_back(s);
    CHECK(split.size() == whole.size(), "split %zu spans vs whole %zu", split.size(), whole.size());
    for (size_t i = 0; i < split.size() && i < whole.size(); ++i) {
      CHECK(split[i].start_ms == whole[i].start_ms && split[i].end_ms == whole[i].end_ms,
            "span %zu: split [%lld,%lld] vs whole [%lld,%lld]", i,
            (long long)split[i].start_ms, (long long)split[i].end_ms,
            (long long)whole[i].start_ms, (long long)whole[i].end_ms);
    }
  }

  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_vad_span_builder: OK\n");
  return 0;
}
