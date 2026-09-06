// Mapping diarization results back from concatenated-speech time to the real recording.
//
// Diarization used to read the WHOLE recording — silence included — into one float vector:
// 346 MB of input for a 90-minute meeting, before sherpa's own copies. Measured on a Pixel 7 Pro
// it was still running after 47 minutes at 2.55 GB and had to be killed. ASR has always been
// restricted to the VAD spans; this is diarization catching up, and this file is the arithmetic
// that makes it safe.
//
// Every timestamp the app shows, every utterance attribution, and every export depends on this
// translation being exact. An off-by-one here silently misattributes speech, which is the one
// diarization error nobody can spot by reading the transcript.
#include "diar/span_map.h"

#include <cstdio>
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

using audionotes::DiarSegment;
using audionotes::Span;
using audionotes::toOriginalTimeline;

int main() {
  // A recording with speech at 10-20s and 60-70s. Concatenated, that is 0-10s and 10-20s.
  const std::vector<Span> spans = {{10000, 20000}, {60000, 70000}};

  {
    // A segment wholly inside the first span: shifted by that span's own offset.
    const std::vector<DiarSegment> in = {{1000, 5000, 0}};
    const auto out = toOriginalTimeline(in, spans);
    CHECK(out.size() == 1, "expected 1 segment, got %zu", out.size());
    CHECK(out[0].start_ms == 11000, "start %lld", (long long)out[0].start_ms);
    CHECK(out[0].end_ms == 15000, "end %lld", (long long)out[0].end_ms);
    CHECK(out[0].speaker == 0, "speaker %d", out[0].speaker);
  }

  {
    // Wholly inside the SECOND span. Concat 12s is 2s into span 2, which began at 60s.
    const std::vector<DiarSegment> in = {{12000, 14000, 1}};
    const auto out = toOriginalTimeline(in, spans);
    CHECK(out.size() == 1, "expected 1, got %zu", out.size());
    CHECK(out[0].start_ms == 62000, "start %lld", (long long)out[0].start_ms);
    CHECK(out[0].end_ms == 64000, "end %lld", (long long)out[0].end_ms);
    CHECK(out[0].speaker == 1, "speaker %d", out[0].speaker);
  }

  {
    // The case that matters. A segment straddling the join must SPLIT: in concatenated time
    // 8s-13s is contiguous, but in the real recording it is 18-20s and 60-63s with forty
    // seconds of silence in between. Emitting one 18s-63s segment would attribute all that
    // silence — and anyone else who spoke in it — to this speaker.
    const std::vector<DiarSegment> in = {{8000, 13000, 2}};
    const auto out = toOriginalTimeline(in, spans);
    CHECK(out.size() == 2, "a straddling segment must split, got %zu", out.size());
    if (out.size() == 2) {
      CHECK(out[0].start_ms == 18000 && out[0].end_ms == 20000, "first half %lld-%lld",
            (long long)out[0].start_ms, (long long)out[0].end_ms);
      CHECK(out[1].start_ms == 60000 && out[1].end_ms == 63000, "second half %lld-%lld",
            (long long)out[1].start_ms, (long long)out[1].end_ms);
      CHECK(out[0].speaker == 2 && out[1].speaker == 2, "speaker must survive the split");
    }
  }

  {
    // Exactly covering everything: both spans come back whole, and no silence is invented.
    const std::vector<DiarSegment> in = {{0, 20000, 3}};
    const auto out = toOriginalTimeline(in, spans);
    CHECK(out.size() == 2, "expected 2, got %zu", out.size());
    if (out.size() == 2) {
      CHECK(out[0].start_ms == 10000 && out[0].end_ms == 20000, "span 1 whole");
      CHECK(out[1].start_ms == 60000 && out[1].end_ms == 70000, "span 2 whole");
    }
  }

  {
    // Zero-length and out-of-range input produce nothing rather than a bogus timestamp.
    CHECK(toOriginalTimeline({{5000, 5000, 0}}, spans).empty(), "empty segment yields nothing");
    CHECK(toOriginalTimeline({{50000, 60000, 0}}, spans).empty(), "past the end yields nothing");
    CHECK(toOriginalTimeline({{1000, 2000, 0}}, {}).empty(), "no spans yields nothing");
  }

  {
    // Results come back sorted by real start time, which is what every caller assumes.
    const std::vector<DiarSegment> in = {{12000, 13000, 1}, {1000, 2000, 0}};
    const auto out = toOriginalTimeline(in, spans);
    CHECK(out.size() == 2, "expected 2, got %zu", out.size());
    if (out.size() == 2) CHECK(out[0].start_ms < out[1].start_ms, "must be sorted by real time");
  }

  {
    // The offsets themselves, since everything above rests on them.
    const auto off = audionotes::concatOffsets(spans);
    CHECK(off.size() == 2 && off[0] == 0 && off[1] == 10000, "offsets 0, 10000");
    CHECK(audionotes::totalSpeechMs(spans) == 20000, "20s of speech in a 70s recording");
  }

  if (failures == 0) std::printf("test_span_map: all checks passed\n");
  return failures ? 1 : 0;
}
