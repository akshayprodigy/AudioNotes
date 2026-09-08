# Live Transcript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transcribe during the capture, so the wait after "stop" drops from ~107 minutes to ~60 on a 90-minute meeting.

**Architecture:** A `LiveTranscriber` thread tails `audio.pcm` while `RecordingService` records, feeds a streaming Silero VAD, decodes chunks that can no longer change, and stores the result in an `asr_cache` table. The existing pipeline is untouched except that its whisper chunk loop consults that cache before decoding. Because whisper sets `no_context`, a chunk decode is a pure function of its audio, so a cache hit is the same value — correctness is structural, not tested-into-existence.

**Tech Stack:** C++17 (whisper.cpp, ONNX Runtime / Silero), JNI, Kotlin, SQLCipher, ctest, JUnit.

**Spec:** `docs/superpowers/specs/2026-09-07-live-transcript-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `cpp/asr/live_chunker.{h,cpp}` | **New.** `finalChunks()` — which chunks can no longer change. Pure, model-free. |
| `cpp/vad/vad_span_builder.{h,cpp}` | **New.** The VAD span state machine (trigger/pad/merge), lifted out of `silero_vad.cpp`. Pure, model-free. |
| `cpp/vad/silero_vad.{h,cpp}` | Gains `reset/feed/finish/pendingSpanStartMs`; `process()` is reimplemented on top of them. |
| `cpp/asr/whisper_asr.{h,cpp}` | Gains `decodeWindow()` (extracted from the loop, shared by both paths) and cache consultation. |
| `cpp/asr/asr_engine.h` | `AsrConfig` carries the pre-computed chunk cache. |
| `cpp/jni/audionotes_jni.cpp` | The two handle APIs; `nativeTranscribe` gains cache parameters. |
| `android/.../pipeline/LiveTranscriber.kt` | **New.** The tail-and-decode loop. |
| `android/.../pipeline/LiveBudget.kt` | **New.** Pure policy: may the live pass start, and should it back off. |
| `android/.../pipeline/RecordingService.kt` | Starts/stops the `LiveTranscriber`. |
| `android/.../pipeline/ProcessingEngine.kt` | Passes the cache down; clears it once ASR completes. |
| `android/.../data/AudioDb.kt` | `asr_cache` table and its accessors. |
| `scripts/check-live-transcript.py` | **New.** Grep guard for the §2 invariant. |

**Why two new pure C++ files rather than code inside the existing ones:** both hold logic where the bugs live and neither needs a model to test. `asr_chunker.cpp` was lifted out of `whisper_asr.cpp` for exactly this reason; follow that precedent.

---

## Phase 1 — Pure core, no models

### Task 1: `finalChunks` — which chunks can no longer change

**Files:**
- Create: `cpp/asr/live_chunker.h`, `cpp/asr/live_chunker.cpp`
- Test: `cpp/tests/test_live_chunker.cpp`
- Modify: `cpp/cli/CMakeLists.txt`

- [ ] **Step 1: Write the failing test**

Create `cpp/tests/test_live_chunker.cpp`:

```cpp
// The live pass must emit a chunk only when no future span could still be packed into it.
// Emitting early is not a correctness bug — the key simply misses and the post-hoc pass decodes
// normally — but it wastes exactly the CPU this feature exists to save.
#include "asr/live_chunker.h"

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

using audionotes::Chunk;
using audionotes::finalChunks;
using audionotes::makeChunks;
using audionotes::Segment;

static const int64_t kBudget = 30000;

static void sameChunks(const std::vector<Chunk>& got, const std::vector<Chunk>& want,
                       const char* what) {
  CHECK(got.size() == want.size(), "%s: got %zu chunks, want %zu", what, got.size(), want.size());
  if (got.size() != want.size()) return;
  for (size_t i = 0; i < got.size(); ++i) {
    CHECK(got[i].start_ms == want[i].start_ms && got[i].end_ms == want[i].end_ms,
          "%s[%zu]: got [%lld,%lld], want [%lld,%lld]", what, i,
          (long long)got[i].start_ms, (long long)got[i].end_ms,
          (long long)want[i].start_ms, (long long)want[i].end_ms);
  }
}

int main() {
  // Nothing captured yet.
  sameChunks(finalChunks({}, -1, 0, kBudget), {}, "empty");

  // One span, silence still short of the merge gap: the next span could still join it.
  sameChunks(finalChunks({{0, 5000}}, -1, 10000, kBudget), {}, "gap not yet elapsed");

  // Same span, 12 s of silence past its end and nothing pending: now it cannot grow.
  sameChunks(finalChunks({{0, 5000}}, -1, 17000, kBudget), {{0, 5000}}, "gap elapsed");

  // THE REGRESSION CASE. Someone is still talking, having started 5 s after the chunk ended.
  // The frontier is far past the 12 s gap, so a frontier-only rule would wrongly call this
  // final — but when that span closes, makeChunks packs it into the SAME chunk.
  sameChunks(finalChunks({{0, 5000}}, 10000, 30000, kBudget), {}, "pending span can still join");

  // A pending span that starts beyond the merge gap cannot join, so the chunk is final.
  sameChunks(finalChunks({{0, 5000}}, 20000, 25000, kBudget), {{0, 5000}}, "pending span too far");

  // A closed span past the chunk means makeChunks already decided with full knowledge.
  {
    const std::vector<Segment> spans = {{0, 5000}, {20000, 25000}};
    sameChunks(finalChunks(spans, -1, 26000, kBudget), {{0, 5000}}, "later span closes the first");
  }

  // The property that matters: replaying a meeting span by span must emit exactly what the
  // offline chunker produces over the whole list — same boundaries, same order, no extras.
  {
    const std::vector<Segment> all = {
      {0, 4000}, {5000, 9000},        // close together: one chunk
      {30000, 34000},                 // 21 s gap: new chunk
      {35000, 60000}, {61000, 92000}, // budget forces a split
      {200000, 203000},               // long silence: new chunk
    };
    std::vector<Chunk> collected;
    for (size_t n = 1; n <= all.size(); ++n) {
      const std::vector<Segment> prefix(all.begin(), all.begin() + n);
      // The frontier sits just past the last released span; the next span is not known yet.
      const int64_t captured = prefix.back().end_ms + 1;
      for (const Chunk& c : finalChunks(prefix, -1, captured, kBudget)) {
        bool seen = false;
        for (const Chunk& e : collected) {
          if (e.start_ms == c.start_ms && e.end_ms == c.end_ms) { seen = true; break; }
        }
        if (!seen) collected.push_back(c);
      }
    }
    // End of capture: everything is final.
    for (const Chunk& c : finalChunks(all, -1, all.back().end_ms + 60000, kBudget)) {
      bool seen = false;
      for (const Chunk& e : collected) {
        if (e.start_ms == c.start_ms && e.end_ms == c.end_ms) { seen = true; break; }
      }
      if (!seen) collected.push_back(c);
    }
    sameChunks(collected, makeChunks(all, kBudget), "incremental == offline");
  }

  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_live_chunker: OK\n");
  return 0;
}
```

- [ ] **Step 2: Run it and watch it fail to compile**

```bash
cd cpp/cli/build && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake --build . --target test_live_chunker
```

Expected: FAIL — `live_chunker.h` does not exist, and the target is not defined.

- [ ] **Step 3: Write the header**

Create `cpp/asr/live_chunker.h`:

```cpp
// Which decode windows are FINAL while a meeting is still being recorded.
//
// The live pass caches a chunk's decode under a key made of its boundaries. If it emits a chunk
// that the finished recording would have packed differently, the post-hoc pass asks for a key
// that was never stored and decodes it again — correct, but the CPU was wasted, which is the one
// thing this feature exists to avoid. So a chunk is emitted only when no future span can join it.
#pragma once
#include <cstdint>
#include <vector>

#include "asr/asr_chunker.h"  // Chunk, makeChunks, kMaxMergeGapMs; Segment via vad/silero_vad.h

namespace audionotes {

// spans:               speech spans the VAD has RELEASED, in order.
// pending_span_start_ms: start of the earliest span the VAD knows about but has not released —
//                      one it is still inside, or one held back pending a merge — or -1 for none.
// captured_ms:         how much audio exists on disk.
//
// The budget cannot certify finality (it depends on where the next span ENDS, which is unknown),
// so the merge gap is the only rule used. That is sufficient, and being conservative costs a
// little latency and never correctness.
std::vector<Chunk> finalChunks(const std::vector<Segment>& spans,
                               int64_t pending_span_start_ms,
                               int64_t captured_ms,
                               int64_t max_chunk_ms,
                               int64_t max_gap_ms = kMaxMergeGapMs);

}  // namespace audionotes
```

- [ ] **Step 4: Write the implementation**

Create `cpp/asr/live_chunker.cpp`:

```cpp
#include "asr/live_chunker.h"

namespace audionotes {

std::vector<Chunk> finalChunks(const std::vector<Segment>& spans,
                               int64_t pending_span_start_ms,
                               int64_t captured_ms,
                               int64_t max_chunk_ms,
                               int64_t max_gap_ms) {
  // Chunk the spans we have. Every chunk but the LAST is necessarily final already: a chunk is
  // only closed by a span that follows it, and makeChunks made that decision knowing that span.
  // The loop still tests each one rather than special-casing the last, because the invariant is
  // worth stating in code that checks it.
  const std::vector<Chunk> all = makeChunks(spans, max_chunk_ms, ChunkMode::kPack, max_gap_ms);
  std::vector<Chunk> out;
  for (const Chunk& c : all) {
    bool closed_by_a_later_span = false;
    for (const Segment& s : spans) {
      if (s.start_ms > c.end_ms) { closed_by_a_later_span = true; break; }
    }
    if (closed_by_a_later_span) { out.push_back(c); continue; }

    // Nothing released past this chunk. Anything the VAD is holding is the candidate joiner.
    if (pending_span_start_ms >= 0 && pending_span_start_ms > c.end_ms) {
      if (pending_span_start_ms - c.end_ms > max_gap_ms) out.push_back(c);
      continue;
    }
    // Nothing held either, so any future span must begin after the capture frontier.
    if (captured_ms - c.end_ms >= max_gap_ms) out.push_back(c);
  }
  return out;
}

}  // namespace audionotes
```

- [ ] **Step 5: Register the test with ctest**

In `cpp/cli/CMakeLists.txt`, immediately after the `audionotes_add_test(test_asr_chunker ...)` block, add:

```cmake
# Chunk finality during a live capture. Model-free on purpose: emitting a chunk one span too
# early is invisible in any transcript — it only shows up as the feature being mysteriously slow.
audionotes_add_test(test_live_chunker
  ${CORE}/tests/test_live_chunker.cpp
  ${CORE}/asr/live_chunker.cpp
  ${CORE}/asr/asr_chunker.cpp)
```

- [ ] **Step 6: Build and run**

```bash
cd cpp/cli/build && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake .. \
  && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake --build . --target test_live_chunker \
  && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/ctest -R test_live_chunker --output-on-failure
```

Expected: `test_live_chunker: OK`, 1 test passed.

- [ ] **Step 7: Commit**

```bash
git add cpp/asr/live_chunker.h cpp/asr/live_chunker.cpp cpp/tests/test_live_chunker.cpp cpp/cli/CMakeLists.txt
git commit -m "feat(live): decide which decode windows can no longer change

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `VadSpanBuilder` — the span state machine, without ONNX

Lifts the trigger/pad/merge logic out of `SileroVad::process` so it can be tested with synthetic
probabilities and reused by the streaming path.

**Files:**
- Create: `cpp/vad/vad_span_builder.h`, `cpp/vad/vad_span_builder.cpp`
- Test: `cpp/tests/test_vad_span_builder.cpp`
- Modify: `cpp/cli/CMakeLists.txt`

- [ ] **Step 1: Write the failing test**

Create `cpp/tests/test_vad_span_builder.cpp`:

```cpp
// The VAD's span logic, fed synthetic probabilities so it can be tested without a model.
// This is where the live path and the file path must agree, and where a padding or merge slip
// would silently shift every chunk boundary and cost every cache hit.
#include "vad/vad_span_builder.h"

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
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd cpp/cli/build && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake --build . --target test_vad_span_builder
```

Expected: FAIL — `vad_span_builder.h` does not exist.

- [ ] **Step 3: Write the header**

Create `cpp/vad/vad_span_builder.h`:

```cpp
// Silero's output is a speech probability per frame. Turning that stream into padded, merged
// speech spans is a small state machine, and it is the part that has to behave identically
// whether the audio arrives from a finished file or from a capture still in progress.
//
// It lives here rather than inside silero_vad.cpp so it can be tested with synthetic
// probabilities and no model at all — the same reason asr_chunker was lifted out of whisper_asr.
#pragma once
#include <cstdint>
#include <vector>

#include "vad/silero_vad.h"  // Segment, VadConfig

namespace audionotes {

class VadSpanBuilder {
 public:
  VadSpanBuilder(const VadConfig& cfg, int sample_rate);

  // Feed one frame's speech probability. `frame_start` is the index of the frame's first sample.
  // Returns any spans RELEASED by this frame — usually none.
  //
  // A closed span is held back until the following span is known, because padding can make two
  // spans overlap and the file path merges them. Holding is what keeps the two paths identical.
  std::vector<Segment> push(float prob, int64_t frame_start);

  // End of audio: release the held span and any span still open. `end_sample` is the total
  // number of samples seen, which is what a still-open span is clamped to.
  std::vector<Segment> finish(int64_t end_sample);

  // Start (ms) of the earliest span this builder knows about but has NOT released — one still in
  // progress, or one closed and held pending a merge. -1 when there is none.
  //
  // The live chunker needs exactly this: both kinds are invisible to the caller and both can
  // still be packed into the previous decode window.
  int64_t pendingSpanStartMs() const;

 private:
  VadConfig cfg_;
  int sample_rate_;
  int64_t min_speech_, min_silence_, pad_;

  bool triggered_ = false;
  int64_t temp_end_ = 0;
  int64_t speech_start_ = 0;
  int64_t cursor_ = 0;  // first sample AFTER the most recent frame

  bool has_held_ = false;
  Segment held_{0, 0};

  std::vector<Segment> release(int64_t start_sample, int64_t end_sample);
};

}  // namespace audionotes
```

- [ ] **Step 4: Write the implementation**

Create `cpp/vad/vad_span_builder.cpp`:

```cpp
#include "vad/vad_span_builder.h"

#include <algorithm>

namespace audionotes {

VadSpanBuilder::VadSpanBuilder(const VadConfig& cfg, int sample_rate)
    : cfg_(cfg),
      sample_rate_(sample_rate),
      min_speech_(static_cast<int64_t>(cfg.min_speech_ms) * sample_rate / 1000),
      min_silence_(static_cast<int64_t>(cfg.min_silence_ms) * sample_rate / 1000),
      pad_(static_cast<int64_t>(cfg.speech_pad_ms) * sample_rate / 1000) {}

// Pad, convert to ms, and merge with whatever is held. Returns what can now be released.
std::vector<Segment> VadSpanBuilder::release(int64_t start_sample, int64_t end_sample) {
  const int64_t s = std::max<int64_t>(0, start_sample - pad_);
  const int64_t e = end_sample + pad_;
  const Segment next{s * 1000 / sample_rate_, e * 1000 / sample_rate_};

  std::vector<Segment> out;
  if (has_held_ && next.start_ms <= held_.end_ms) {
    held_.end_ms = std::max(held_.end_ms, next.end_ms);  // overlap after padding: one span
    return out;
  }
  if (has_held_) out.push_back(held_);
  held_ = next;
  has_held_ = true;
  return out;
}

std::vector<Segment> VadSpanBuilder::push(float prob, int64_t frame_start) {
  const float neg_threshold = cfg_.threshold - 0.15f;
  cursor_ = frame_start + cfg_.window;

  std::vector<Segment> out;
  if (prob >= cfg_.threshold && temp_end_ != 0) temp_end_ = 0;
  if (prob >= cfg_.threshold && !triggered_) {
    triggered_ = true;
    speech_start_ = frame_start;
  } else if (prob < neg_threshold && triggered_) {
    if (temp_end_ == 0) temp_end_ = frame_start;
    if (cursor_ - temp_end_ >= min_silence_) {
      if (temp_end_ - speech_start_ > min_speech_) out = release(speech_start_, temp_end_);
      triggered_ = false;
      temp_end_ = 0;
    }
  }
  return out;
}

std::vector<Segment> VadSpanBuilder::finish(int64_t end_sample) {
  std::vector<Segment> out;
  if (triggered_ && end_sample - speech_start_ > min_speech_) {
    out = release(speech_start_, end_sample);
    triggered_ = false;
  }
  if (has_held_) {
    // The file path clamps a span's padded end to the length of the audio.
    held_.end_ms = std::min(held_.end_ms, end_sample * 1000 / sample_rate_);
    out.push_back(held_);
    has_held_ = false;
  }
  return out;
}

int64_t VadSpanBuilder::pendingSpanStartMs() const {
  if (has_held_) return held_.start_ms;
  if (triggered_) {
    return std::max<int64_t>(0, speech_start_ - pad_) * 1000 / sample_rate_;
  }
  return -1;
}

}  // namespace audionotes
```

- [ ] **Step 5: Register the test**

In `cpp/cli/CMakeLists.txt`, immediately after the `audionotes_add_test(test_live_chunker ...)` block, add:

```cmake
# The VAD span state machine, driven by synthetic probabilities so no model is needed. The live
# path and the file path share this code; a slip here shifts every chunk boundary at once.
audionotes_add_test(test_vad_span_builder
  ${CORE}/tests/test_vad_span_builder.cpp
  ${CORE}/vad/vad_span_builder.cpp)
```

- [ ] **Step 6: Build and run**

```bash
cd cpp/cli/build && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake .. \
  && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake --build . --target test_vad_span_builder \
  && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/ctest -R test_vad_span_builder --output-on-failure
```

Expected: `test_vad_span_builder: OK`.

- [ ] **Step 7: Commit**

```bash
git add cpp/vad/vad_span_builder.h cpp/vad/vad_span_builder.cpp cpp/tests/test_vad_span_builder.cpp cpp/cli/CMakeLists.txt
git commit -m "feat(vad): lift the span state machine out, so it can be tested without a model

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Rebuild `SileroVad::process` on a streaming API

Parity between the live VAD and the file VAD stops being a property to test and becomes the same
code path: `process()` is `reset` + `feed(whole file)` + `finish`.

**Files:**
- Modify: `cpp/vad/silero_vad.h`, `cpp/vad/silero_vad.cpp`
- Modify: `cpp/CMakeLists.txt`, `cpp/cli/CMakeLists.txt` (add `vad_span_builder.cpp` to every target that builds `silero_vad.cpp`)

- [ ] **Step 1: Extend the header**

In `cpp/vad/silero_vad.h`, replace the `class SileroVad { ... };` block with:

```cpp
class SileroVad {
 public:
  SileroVad(const std::string& model_path, int sample_rate);
  ~SileroVad();

  // Stream a PCM16 mono file frame by frame (never loads the whole file into RAM).
  // Returns merged, padded speech segments in milliseconds.
  //
  // Implemented as reset() + feed(the whole file) + finish(), so the live capture path and this
  // one are not merely equivalent — they are the same code. That is the only way the live pass
  // can key a cache on chunk boundaries and expect the finished recording to ask for them.
  std::vector<Segment> process(const std::string& pcm_path, const VadConfig& cfg = VadConfig());

  // ---- Streaming API, for transcribing while the recording is still being written ----

  // Start a new stream. Must be called before the first feed().
  void reset(const VadConfig& cfg = VadConfig());

  // Consume [from_byte, from_byte + byte_count) of a PCM16 mono file and return any spans
  // released. Bytes that do not complete a frame are retained for the next call, so feeding
  // [A][B] gives exactly what feeding [AB] gives.
  std::vector<Segment> feed(const std::string& pcm_path, int64_t from_byte, int64_t byte_count);

  // No more audio is coming: release the held span and any span still open.
  std::vector<Segment> finish();

  // Start (ms) of the earliest span known but not released, or -1. See VadSpanBuilder.
  int64_t pendingSpanStartMs() const;

 private:
  struct Impl;
  Impl* impl_;
};
```

- [ ] **Step 2: Rewrite the implementation**

In `cpp/vad/silero_vad.cpp`, add `#include "vad/vad_span_builder.h"` beneath the existing
`#include "util/ort_init.h"`, then add these fields to `struct SileroVad::Impl` immediately after
`float max_prob = 0.0f;`:

```cpp
  // Streaming state. `builder` is null until reset() opens a stream.
  std::unique_ptr<VadSpanBuilder> builder;
  VadConfig cfg;
  std::vector<int16_t> residual;  // bytes fed that did not complete a frame
  int64_t stream_cursor = 0;      // samples consumed by the stream so far
```

and `#include <memory>` at the top. Then replace the whole of `SileroVad::process` with:

```cpp
void SileroVad::reset(const VadConfig& cfg) {
  impl_->reset();
  impl_->cfg = cfg;
  impl_->builder.reset(new VadSpanBuilder(cfg, impl_->sample_rate));
  impl_->residual.clear();
  impl_->stream_cursor = 0;
  VADLOGI("stream open: model=%s window=%d threshold=%.2f",
          impl_->v5 ? "v5(state)" : "v4(h/c)", cfg.window, cfg.threshold);
}

std::vector<Segment> SileroVad::feed(const std::string& pcm_path, int64_t from_byte,
                                     int64_t byte_count) {
  std::vector<Segment> out;
  if (!impl_->builder || byte_count <= 0) return out;

  FILE* f = std::fopen(pcm_path.c_str(), "rb");
  if (!f) return out;
  if (std::fseek(f, static_cast<long>(from_byte), SEEK_SET) != 0) {
    std::fclose(f);
    return out;
  }

  const int window = impl_->cfg.window;
  std::vector<int16_t> raw(static_cast<size_t>(byte_count / 2));
  const size_t got = raw.empty() ? 0 : std::fread(raw.data(), sizeof(int16_t), raw.size(), f);
  std::fclose(f);

  // Prepend whatever did not complete a frame last time, so frame alignment never depends on
  // how the caller happened to slice the file.
  impl_->residual.insert(impl_->residual.end(), raw.begin(), raw.begin() + got);

  std::vector<float> frame(window);
  size_t off = 0;
  while (impl_->residual.size() - off >= static_cast<size_t>(window)) {
    for (int i = 0; i < window; ++i) {
      frame[i] = static_cast<float>(impl_->residual[off + i]) / 32768.0f;
    }
    const float prob = impl_->infer(frame);
    for (const Segment& s : impl_->builder->push(prob, impl_->stream_cursor)) out.push_back(s);
    impl_->stream_cursor += window;
    off += window;
  }
  impl_->residual.erase(impl_->residual.begin(), impl_->residual.begin() + off);
  return out;
}

std::vector<Segment> SileroVad::finish() {
  if (!impl_->builder) return {};
  const int window = impl_->cfg.window;

  // A final short frame is zero-padded to a full window, exactly as the file path did.
  if (!impl_->residual.empty()) {
    std::vector<float> frame(window, 0.0f);
    for (size_t i = 0; i < impl_->residual.size() && i < static_cast<size_t>(window); ++i) {
      frame[i] = static_cast<float>(impl_->residual[i]) / 32768.0f;
    }
    const float prob = impl_->infer(frame);
    std::vector<Segment> partial = impl_->builder->push(prob, impl_->stream_cursor);
    impl_->stream_cursor += window;
    impl_->residual.clear();
    std::vector<Segment> tail = impl_->builder->finish(impl_->stream_cursor);
    partial.insert(partial.end(), tail.begin(), tail.end());
    VADLOGI("stream closed at %.1fs, peak speech prob %.3f",
            static_cast<double>(impl_->stream_cursor) / impl_->sample_rate, impl_->max_prob);
    return partial;
  }
  std::vector<Segment> tail = impl_->builder->finish(impl_->stream_cursor);
  VADLOGI("stream closed at %.1fs, peak speech prob %.3f",
          static_cast<double>(impl_->stream_cursor) / impl_->sample_rate, impl_->max_prob);
  return tail;
}

int64_t SileroVad::pendingSpanStartMs() const {
  return impl_->builder ? impl_->builder->pendingSpanStartMs() : -1;
}

std::vector<Segment> SileroVad::process(const std::string& pcm_path, const VadConfig& cfg) {
  FILE* f = std::fopen(pcm_path.c_str(), "rb");
  if (!f) return {};
  std::fseek(f, 0, SEEK_END);
  const long bytes = std::ftell(f);
  std::fclose(f);
  if (bytes <= 0) return {};

  reset(cfg);
  std::vector<Segment> out = feed(pcm_path, 0, bytes);
  for (const Segment& s : finish()) out.push_back(s);
  VADLOGI("scanned %.1fs -> %zu segment(s)",
          static_cast<double>(impl_->stream_cursor) / impl_->sample_rate, out.size());
  return out;
}
```

- [ ] **Step 3: Add the new source to every target that builds the VAD**

In `cpp/CMakeLists.txt`, add `vad/vad_span_builder.cpp` immediately after `vad/silero_vad.cpp` in
the `add_library(audionotes SHARED ...)` list.

In `cpp/cli/CMakeLists.txt`, add `${CORE}/vad/vad_span_builder.cpp` immediately after every
occurrence of `${CORE}/vad/silero_vad.cpp`. There are five: `audionotes_cli`, `test_asr_factory`,
`test_pipeline_align`, `test_cancel` and `test_capi`.

> A missing entry here is a link error, not a silent failure — but `speaker_match.cpp` was
> forgotten in exactly these five places once already, so check all five.

- [ ] **Step 4: Rebuild everything and run the whole suite**

```bash
cd cpp/cli/build && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake .. \
  && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake --build . -j8 \
  && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/ctest --output-on-failure
```

Expected: every test passes, including the pre-existing ones. `process()` changed shape, so a
regression shows up here.

- [ ] **Step 5: Prove the rewrite did not move a single span**

The unit tests do not use a real model, so confirm against real audio with the CLI:

```bash
cd cpp/cli/build && ./audionotes_cli --vad-only \
  --vad-model ../../../models/silero_vad.onnx \
  --pcm ../../../eval/fixtures/ES2002a.pcm | tee /tmp/vad-after.txt
git stash && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake --build . -j8 \
  && ./audionotes_cli --vad-only --vad-model ../../../models/silero_vad.onnx \
     --pcm ../../../eval/fixtures/ES2002a.pcm > /tmp/vad-before.txt
git stash pop && diff /tmp/vad-before.txt /tmp/vad-after.txt && echo "IDENTICAL"
```

Expected: `IDENTICAL`. If `--vad-only` is not a flag `main.cpp` accepts, run the full
`eval/run.py` on one fixture before and after instead and diff the segment counts.

- [ ] **Step 6: Commit**

```bash
git add cpp/vad/silero_vad.h cpp/vad/silero_vad.cpp cpp/CMakeLists.txt cpp/cli/CMakeLists.txt
git commit -m "refactor(vad): make the file path a special case of the streaming path

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — whisper: one decode path, and a cache in front of it

### Task 4: One decode path, with a cache in front of it

Both halves land together because neither compiles without the other.

**Files:**
- Modify: `cpp/asr/asr_engine.h`, `cpp/asr/whisper_asr.h`, `cpp/asr/whisper_asr.cpp`, `cpp/asr/asr_factory.cpp`

- [ ] **Step 1: Add the cache type and the counter**

In `cpp/asr/asr_engine.h`, add above `struct AsrRun`:

```cpp
// A window somebody already decoded — in practice the live pass that ran during the capture.
// `utterances` carry CHUNK-RELATIVE timestamps, exactly as WhisperAsr::decodeWindow returns them.
struct AsrCachedWindow {
  int64_t start_ms;
  int64_t end_ms;
  std::vector<Utterance> utterances;
};
```

In `struct AsrRun`, add beside `chunks_failed`:

```cpp
  // Windows served from the cache rather than decoded. Provenance, and the only way to tell
  // whether the live pass actually helped on a given phone.
  int chunks_cached = 0;
```

In `struct AsrConfig`, add at the end:

```cpp
  // Pre-computed windows for THIS recording. Not configuration in spirit, but it travels the same
  // path, and adding a parameter to AsrEngine::transcribe would change a five-engine interface
  // for something only whisper consults. Empty for every run that had no live pass.
  //
  // A window is used only if its boundaries match EXACTLY, so a cache built against different VAD
  // spans is inert rather than wrong.
  std::vector<AsrCachedWindow> chunk_cache;
```

- [ ] **Step 2: Store it and look it up**

In `cpp/asr/whisper_asr.cpp`, add to `struct WhisperAsr::Impl` after `bool skip_refusal = false;`:

```cpp
  std::vector<AsrCachedWindow> cache;

  const std::vector<Utterance>* cachedWindow(int64_t start_ms, int64_t end_ms) const {
    for (const AsrCachedWindow& w : cache) {
      if (w.start_ms == start_ms && w.end_ms == end_ms) return &w.utterances;
    }
    return nullptr;
  }
```

Add the setter beneath the other `WhisperAsr::` definitions:

```cpp
void WhisperAsr::setChunkCache(std::vector<AsrCachedWindow> cache) {
  impl_->cache = std::move(cache);
}
```

Declare both new methods in `cpp/asr/whisper_asr.h`, inside `class WhisperAsr`, above `transcribe`:

```cpp
  // Decode ONE window and return its segments with CHUNK-RELATIVE timestamps.
  //
  // Public because the live capture path decodes the same windows ahead of time and must produce
  // byte-identical results; sharing this body is what guarantees that, rather than two call sites
  // that merely look alike. Returns empty on a decode failure or an unreadable range.
  std::vector<Utterance> decodeWindow(const std::string& pcm_path, int sample_rate,
                                      int64_t start_ms, int64_t end_ms, int threads);

  // Hand this run the windows the live capture pass already decoded. See AsrConfig::chunk_cache.
  void setChunkCache(std::vector<AsrCachedWindow> cache);
```

In `cpp/asr/asr_factory.cpp`, find where the whisper engine is constructed and add, while the
concrete type is still in hand and before it is returned as an `AsrEngine`:

```cpp
  engine->setChunkCache(cfg.chunk_cache);
```

- [ ] **Step 3: Extract the per-window decode**

In `cpp/asr/whisper_asr.cpp`, add this definition immediately above `WhisperAsr::transcribe`:

```cpp
std::vector<Utterance> WhisperAsr::decodeWindow(const std::string& pcm_path, int sample_rate,
                                                int64_t start_ms, int64_t end_ms, int threads) {
  std::vector<Utterance> out;
#ifdef HAVE_WHISPER
  if (!impl_->ok) return out;
  std::vector<float> samples = readWindow(pcm_path, sample_rate, start_ms, end_ms);
  if (samples.empty()) return out;

  whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  wparams.print_progress = false;
  wparams.print_realtime = false;
  wparams.print_special = false;
  wparams.translate = false;
  wparams.language = impl_->language.c_str();
  wparams.n_threads = threads;
  // Every window is decoded with no carried state. That is what makes a window's decode a pure
  // function of its audio — and therefore what makes caching it sound.
  wparams.no_context = true;

  if (whisper_full(impl_->ctx, wparams, samples.data(), static_cast<int>(samples.size())) != 0) {
    return out;  // the caller counts the failure; see transcribe()
  }

  const int n = whisper_full_n_segments(impl_->ctx);
  for (int i = 0; i < n; ++i) {
    const char* text = whisper_full_get_segment_text(impl_->ctx, i);
    // whisper t0/t1 are in centiseconds (1/100 s). Kept RELATIVE to the window here; the caller
    // anchors them. See asr_postprocess.h for why the text is scrubbed at this exact point.
    const int64_t t0 = whisper_full_get_segment_t0(impl_->ctx, i) * 10;
    const int64_t t1 = whisper_full_get_segment_t1(impl_->ctx, i) * 10;
    const std::string s = normalizeSegmentText(text ? text : "");
    if (!s.empty()) out.push_back(Utterance{t0, t1, s});
  }
#else
  (void)pcm_path; (void)sample_rate; (void)start_ms; (void)end_ms; (void)threads;
#endif
  return out;
}
```

- [ ] **Step 4: Route the loop through it, via the cache**

In `WhisperAsr::transcribe`, replace everything in the `for (int ci = 0; ci < total; ++ci)` body
from `const auto& ch = chunks[ci];` down to the closing brace before the final
`if (progress) progress(ci + 1, total);` with:

```cpp
    const auto& ch = chunks[ci];
    // A decode this run does not have to do, because the live capture pass already did it. The
    // value is the same value: see decodeWindow's no_context note.
    const std::vector<Utterance>* cached = impl_->cachedWindow(ch.start_ms, ch.end_ms);
    const std::vector<Utterance> decoded =
        cached ? *cached : decodeWindow(pcm_path, sample_rate, ch.start_ms, ch.end_ms, threads);
    if (cached) {
      ++run.chunks_cached;
    } else if (decoded.empty()) {
      // Distinguish "the window held no speech" from "the decode failed", which the pipeline
      // once reported identically.
      if (!readWindow(pcm_path, sample_rate, ch.start_ms, ch.end_ms).empty()) ++run.chunks_failed;
      if (progress) progress(ci + 1, total);
      continue;
    }
    for (const Utterance& u : decoded) {
      run.utterances.push_back(
          Utterance{ch.start_ms + u.start_ms, ch.start_ms + u.end_ms, u.text});
    }
```

Then add after the `ASRLOGI("transcribing %d chunk(s)...` line:

```cpp
  if (!impl_->cache.empty()) {
    ASRLOGI("%zu window(s) offered by the live pass", impl_->cache.size());
  }
```

- [ ] **Step 5: Build and run the whole suite**

```bash
cd cpp/cli/build && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake --build . -j8 \
  && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/ctest --output-on-failure
```

Expected: everything passes. The decode path moved, so a regression surfaces here.

- [ ] **Step 6: Prove the refactor moved no words**

```bash
cd eval && python3 run.py --fixture ES2002a --out /tmp/after.json
git stash && python3 run.py --fixture ES2002a --out /tmp/before.json && git stash pop
python3 -c "
import json
a=[u['text'] for u in json.load(open('/tmp/before.json'))['transcript']]
b=[u['text'] for u in json.load(open('/tmp/after.json'))['transcript']]
print('IDENTICAL' if a==b else 'DIFFERS'); assert a==b"
```

Expected: `IDENTICAL`. With an empty cache the loop must behave exactly as it did.

- [ ] **Step 7: Commit**

```bash
git add cpp/asr/asr_engine.h cpp/asr/whisper_asr.h cpp/asr/whisper_asr.cpp cpp/asr/asr_factory.cpp
git commit -m "feat(asr): one decode path, and a cache a run may be handed

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Pin the lookup rule

**Files:**
- Test: `cpp/tests/test_asr_cache.cpp`
- Modify: `cpp/cli/CMakeLists.txt`

- [ ] **Step 1: Write the test**

Create `cpp/tests/test_asr_cache.cpp`:

```cpp
// The cache lookup: exact boundaries only. A window whose start or end differs by a millisecond
// is a DIFFERENT window, and serving it would put one stretch of audio's words on another's
// timestamps. Model-free — this tests the lookup rule, not whisper.
#include "asr/asr_engine.h"

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

using audionotes::AsrCachedWindow;
using audionotes::Utterance;

// Mirrors WhisperAsr::Impl::cachedWindow. Kept here so the rule is pinned without linking
// whisper; if the two ever diverge, test_pipeline_align's transcripts change and say so.
static const std::vector<Utterance>* lookup(const std::vector<AsrCachedWindow>& cache,
                                            int64_t start_ms, int64_t end_ms) {
  for (const AsrCachedWindow& w : cache) {
    if (w.start_ms == start_ms && w.end_ms == end_ms) return &w.utterances;
  }
  return nullptr;
}

int main() {
  const std::vector<AsrCachedWindow> cache = {
    {0, 30000, {Utterance{0, 1000, "hello"}, Utterance{1000, 2000, "there"}}},
    {30000, 55000, {Utterance{0, 500, "again"}}},
  };

  CHECK(lookup(cache, 0, 30000) != nullptr, "exact match hits");
  CHECK(lookup(cache, 0, 30000)->size() == 2, "a window keeps all of its segments");
  CHECK(lookup(cache, 30000, 55000) != nullptr, "second window hits");
  CHECK(lookup(cache, 0, 29999) == nullptr, "end off by one misses");
  CHECK(lookup(cache, 1, 30000) == nullptr, "start off by one misses");
  CHECK(lookup(cache, 60000, 90000) == nullptr, "unknown window misses");
  CHECK(lookup({}, 0, 30000) == nullptr, "empty cache misses");

  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("test_asr_cache: OK\n");
  return 0;
}
```

- [ ] **Step 2: Register it**

In `cpp/cli/CMakeLists.txt`, after the `test_vad_span_builder` block:

```cmake
# The chunk-cache lookup rule: exact boundaries only.
audionotes_add_test(test_asr_cache ${CORE}/tests/test_asr_cache.cpp)
```

- [ ] **Step 3: Build and run**

```bash
cd cpp/cli/build && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake .. \
  && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake --build . --target test_asr_cache \
  && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/ctest -R test_asr_cache --output-on-failure
```

Expected: `test_asr_cache: OK`.

- [ ] **Step 4: Commit**

```bash
git add cpp/tests/test_asr_cache.cpp cpp/cli/CMakeLists.txt
git commit -m "test(asr): a cached window is used only on an exact boundary match

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: JNI — the two handle APIs and the cache parameters

**Files:**
- Modify: `cpp/jni/audionotes_jni.cpp`, `android/.../pipeline/NativeBridge.kt`

- [ ] **Step 1: Add the VAD handle functions**

In `cpp/jni/audionotes_jni.cpp`, add above the `nativeLlmLoad` block:

```cpp
// ---------------------------------------------------------------------------------------------
// Streaming VAD and ASR handles, for transcribing while the recording is still being written.
//
// Handle-based for one reason: nativeTranscribe builds a fresh engine per call, so whisper
// re-reads its weights from disk every time. That is fine once per meeting and impossible once
// per 30-second window. Same shape as nativeLlmLoad/Generate/Free below.
// ---------------------------------------------------------------------------------------------

extern "C" JNIEXPORT jlong JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeVadOpen(
    JNIEnv* env, jobject /*thiz*/, jstring jModelPath, jint sampleRate) {
  const std::string path = jstr(env, jModelPath);
  try {
    auto* vad = new audionotes::SileroVad(path, static_cast<int>(sampleRate));
    vad->reset();
    return reinterpret_cast<jlong>(vad);
  } catch (const std::exception& e) {
    ASRLOG("nativeVadOpen failed: %s", e.what());
    return 0;
  }
}

extern "C" JNIEXPORT jlongArray JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeVadFeed(
    JNIEnv* env, jobject /*thiz*/, jlong handle, jstring jPcmPath, jlong fromByte,
    jlong byteCount) {
  auto* vad = reinterpret_cast<audionotes::SileroVad*>(handle);
  if (!vad) return env->NewLongArray(0);
  std::vector<audionotes::Segment> segs;
  try {
    segs = vad->feed(jstr(env, jPcmPath), fromByte, byteCount);
  } catch (const std::exception& e) {
    ASRLOG("nativeVadFeed failed: %s", e.what());
    return env->NewLongArray(0);
  }
  return segmentsToJava(env, segs);
}

extern "C" JNIEXPORT jlongArray JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeVadFinish(
    JNIEnv* env, jobject /*thiz*/, jlong handle) {
  auto* vad = reinterpret_cast<audionotes::SileroVad*>(handle);
  if (!vad) return env->NewLongArray(0);
  std::vector<audionotes::Segment> segs;
  try {
    segs = vad->finish();
  } catch (const std::exception& e) {
    ASRLOG("nativeVadFinish failed: %s", e.what());
    return env->NewLongArray(0);
  }
  return segmentsToJava(env, segs);
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeVadPendingSpanStartMs(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle) {
  auto* vad = reinterpret_cast<audionotes::SileroVad*>(handle);
  return vad ? static_cast<jlong>(vad->pendingSpanStartMs()) : -1;
}

extern "C" JNIEXPORT void JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeVadClose(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle) {
  delete reinterpret_cast<audionotes::SileroVad*>(handle);
}
```

Add this helper immediately above those functions (the flat `[start,end,...]` shape `nativeVad`
already returns):

```cpp
static jlongArray segmentsToJava(JNIEnv* env, const std::vector<audionotes::Segment>& segs) {
  const jsize n = static_cast<jsize>(segs.size() * 2);
  jlongArray arr = env->NewLongArray(n);
  if (!arr || n == 0) return arr ? arr : env->NewLongArray(0);
  std::vector<jlong> flat;
  flat.reserve(static_cast<size_t>(n));
  for (const audionotes::Segment& s : segs) {
    flat.push_back(static_cast<jlong>(s.start_ms));
    flat.push_back(static_cast<jlong>(s.end_ms));
  }
  env->SetLongArrayRegion(arr, 0, n, flat.data());
  return arr;
}
```

- [ ] **Step 2: Add the ASR handle and the live chunker**

Immediately after the VAD block in `cpp/jni/audionotes_jni.cpp`:

```cpp
extern "C" JNIEXPORT jlong JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeAsrOpen(
    JNIEnv* env, jobject /*thiz*/, jstring jModelPath, jstring jLanguage) {
  auto* asr = new audionotes::WhisperAsr(jstr(env, jModelPath), jstr(env, jLanguage), false);
  if (!asr->ok()) {
    delete asr;
    return 0;
  }
  return reinterpret_cast<jlong>(asr);
}

// Decode ONE window. Returns the same JSON shape nativeTranscribe returns, but with
// CHUNK-RELATIVE timestamps, because that is what makes the value cacheable: it depends on the
// window's audio and nothing about where the window sits in the meeting.
extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeAsrDecodeWindow(
    JNIEnv* env, jobject /*thiz*/, jlong handle, jstring jPcmPath, jint sampleRate,
    jlong startMs, jlong endMs, jint threads) {
  auto* asr = reinterpret_cast<audionotes::WhisperAsr*>(handle);
  if (!asr) return env->NewStringUTF("[]");
  std::vector<audionotes::Utterance> utts;
  try {
    utts = asr->decodeWindow(jstr(env, jPcmPath), static_cast<int>(sampleRate), startMs, endMs,
                             static_cast<int>(threads));
  } catch (const std::exception& e) {
    ASRLOG("nativeAsrDecodeWindow failed: %s", e.what());
    return env->NewStringUTF("[]");
  }
  std::string json = "[";
  for (size_t i = 0; i < utts.size(); ++i) {
    if (i) json += ",";
    std::string esc;
    jsonEscape(utts[i].text, esc);
    json += "{\"t0\":" + std::to_string(utts[i].start_ms) +
            ",\"t1\":" + std::to_string(utts[i].end_ms) + ",\"text\":\"" + esc + "\"}";
  }
  json += "]";
  return env->NewStringUTF(json.c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeAsrClose(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle) {
  delete reinterpret_cast<audionotes::WhisperAsr*>(handle);
}

// Which windows can no longer change. Kotlin drives the live loop but must not own the chunking
// rule — it exists once, in asr_chunker.cpp, and the post-hoc pass uses the same one.
extern "C" JNIEXPORT jlongArray JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLiveChunks(
    JNIEnv* env, jobject /*thiz*/, jlongArray jSpans, jlong pendingSpanStartMs, jlong capturedMs) {
  std::vector<audionotes::Segment> spans;
  const jsize n = env->GetArrayLength(jSpans);
  if (n >= 2) {
    std::vector<jlong> flat(static_cast<size_t>(n));
    env->GetLongArrayRegion(jSpans, 0, n, flat.data());
    for (jsize i = 0; i + 1 < n; i += 2) {
      spans.push_back(audionotes::Segment{flat[i], flat[i + 1]});
    }
  }
  const std::vector<audionotes::Chunk> chunks =
      audionotes::finalChunks(spans, pendingSpanStartMs, capturedMs, 30000);
  std::vector<jlong> out;
  out.reserve(chunks.size() * 2);
  for (const audionotes::Chunk& c : chunks) {
    out.push_back(static_cast<jlong>(c.start_ms));
    out.push_back(static_cast<jlong>(c.end_ms));
  }
  jlongArray arr = env->NewLongArray(static_cast<jsize>(out.size()));
  if (arr && !out.empty()) {
    env->SetLongArrayRegion(arr, 0, static_cast<jsize>(out.size()), out.data());
  }
  return arr ? arr : env->NewLongArray(0);
}
```

Add `#include "asr/live_chunker.h"` and `#include "asr/whisper_asr.h"` to the includes at the top
of the file if they are not already present.

- [ ] **Step 3: Give `nativeTranscribe` the cache**

In `cpp/jni/audionotes_jni.cpp`, change the `nativeTranscribe` signature to take two more
arguments after `jForceLanguage`:

```cpp
    jlongArray jCachedRanges, jobjectArray jCachedJson
```

and immediately before `std::unique_ptr<audionotes::AsrEngine> asr = audionotes::makeAsrEngine(acfg);`
insert:

```cpp
    // Windows the live capture pass already decoded, as parallel arrays: ranges are flat
    // [start0,end0,start1,end1,...] and each JSON string holds that window's chunk-relative
    // segments. Passed in rather than read here because the cache lives in the app's encrypted
    // database, which native code has no key for — and should not.
    if (jCachedRanges != nullptr && jCachedJson != nullptr) {
      const jsize rn = env->GetArrayLength(jCachedRanges);
      const jsize cn = env->GetArrayLength(jCachedJson);
      if (rn / 2 == cn) {
        std::vector<jlong> ranges(static_cast<size_t>(rn));
        if (rn > 0) env->GetLongArrayRegion(jCachedRanges, 0, rn, ranges.data());
        for (jsize i = 0; i < cn; ++i) {
          auto* js = static_cast<jstring>(env->GetObjectArrayElement(jCachedJson, i));
          audionotes::AsrCachedWindow w;
          w.start_ms = ranges[i * 2];
          w.end_ms = ranges[i * 2 + 1];
          w.utterances = parseWindowJson(jstr(env, js));
          env->DeleteLocalRef(js);
          acfg.chunk_cache.push_back(std::move(w));
        }
      } else {
        ASRLOG("ignoring chunk cache: %d range(s) for %d window(s)", (int)(rn / 2), (int)cn);
      }
    }
```

Add this parser above `nativeTranscribe` (a minimal reader for the exact shape
`nativeAsrDecodeWindow` emits — not a general JSON parser, and it must not become one):

```cpp
// Reads exactly what nativeAsrDecodeWindow writes: [{"t0":N,"t1":N,"text":"..."}]. Anything it
// does not recognise yields no utterances, which costs a cache miss and never a wrong transcript.
static std::vector<audionotes::Utterance> parseWindowJson(const std::string& s) {
  std::vector<audionotes::Utterance> out;
  size_t i = 0;
  while ((i = s.find("{\"t0\":", i)) != std::string::npos) {
    i += 6;
    const int64_t t0 = std::strtoll(s.c_str() + i, nullptr, 10);
    size_t j = s.find("\"t1\":", i);
    if (j == std::string::npos) break;
    j += 5;
    const int64_t t1 = std::strtoll(s.c_str() + j, nullptr, 10);
    size_t k = s.find("\"text\":\"", j);
    if (k == std::string::npos) break;
    k += 8;
    std::string text;
    for (; k < s.size(); ++k) {
      if (s[k] == '\\' && k + 1 < s.size()) {
        const char c = s[++k];
        text += (c == 'n') ? '\n' : (c == 't') ? '\t' : c;
      } else if (s[k] == '"') {
        break;
      } else {
        text += s[k];
      }
    }
    if (!text.empty()) out.push_back(audionotes::Utterance{t0, t1, text});
    i = k;
  }
  return out;
}
```

- [ ] **Step 4: Declare everything in Kotlin**

In `android/.../pipeline/NativeBridge.kt`, add after the `nativeVad` declaration:

```kotlin
  /**
   * Streaming VAD, for running while a recording is still being written.
   *
   * `nativeVadFeed` consumes a byte range of the PCM file and returns the spans that range
   * CLOSED, flat as [start0, end0, ...] — usually none. Bytes that do not complete a 512-sample
   * frame are retained, so feeding a file in pieces gives exactly what feeding it whole gives.
   *
   * `nativeVadPendingSpanStartMs` reports the earliest span the VAD knows about but has not
   * handed back — one it is still inside, or one it is holding to see whether padding merges it
   * into the next. Chunk finality needs it: both kinds can still join the previous decode window
   * and neither is visible in what feed() returned. -1 when there is none.
   */
  external fun nativeVadOpen(modelPath: String, sampleRate: Int): Long
  external fun nativeVadFeed(handle: Long, pcmPath: String, fromByte: Long, byteCount: Long): LongArray
  external fun nativeVadFinish(handle: Long): LongArray
  external fun nativeVadPendingSpanStartMs(handle: Long): Long
  external fun nativeVadClose(handle: Long)

  /**
   * A whisper context that stays loaded across windows.
   *
   * nativeTranscribe builds a fresh engine per call, so it re-reads the weights from disk every
   * time — fine once per meeting, impossible once per 30-second window.
   *
   * `nativeAsrDecodeWindow` returns [{"t0":ms,"t1":ms,"text":"..."}] with timestamps RELATIVE to
   * the window, which is what makes the result cacheable: it depends on the window's audio and
   * nothing about where the window sits in the meeting.
   */
  external fun nativeAsrOpen(modelPath: String, language: String): Long
  external fun nativeAsrDecodeWindow(
    handle: Long, pcmPath: String, sampleRate: Int, startMs: Long, endMs: Long, threads: Int,
  ): String
  external fun nativeAsrClose(handle: Long)

  /**
   * Which decode windows can no longer change, given the spans released so far, the earliest
   * span still pending (or -1) and how much audio exists. Flat [start0, end0, ...].
   *
   * The chunking rule lives in C++ with the post-hoc pass and is not reimplemented here: two
   * copies that drift would cost every cache hit and nothing would fail.
   */
  external fun nativeLiveChunks(
    spansMs: LongArray, pendingSpanStartMs: Long, capturedMs: Long,
  ): LongArray
```

Then extend the existing `nativeTranscribe` declaration with the two new parameters:

```kotlin
    forceLanguage: Boolean = false,
    cachedRangesMs: LongArray = LongArray(0),
    cachedWindowsJson: Array<String> = emptyArray(),
  ): String
```

- [ ] **Step 5: Build the Android library**

```bash
cd android && ./gradlew :app:assembleDebug
```

Expected: BUILD SUCCESSFUL. A JNI name mismatch surfaces at runtime, not here, so Task 13's device
run is what actually proves these bind.

- [ ] **Step 6: Commit**

```bash
git add cpp/jni/audionotes_jni.cpp android/app/src/main/java/com/innocorelabs/verbale/pipeline/NativeBridge.kt
git commit -m "feat(jni): streaming VAD and a whisper context that survives a window

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — the cache table

### Task 7: `asr_cache` in the database

**Files:**
- Modify: `android/.../data/AudioDb.kt`
- Test: `android/app/src/test/java/com/innocorelabs/verbale/data/AsrCacheTest.kt`

- [ ] **Step 1: Add the table**

In `AudioDb.kt`, in the `SCHEMA` array immediately after the `llm_notes` entry:

```kotlin
      // Windows the live capture pass decoded while the meeting was still being recorded, so the
      // post-hoc ASR stage does not decode them again. Keyed on the exact window, because a
      // window whose boundaries differ is a different window and serving it would put one
      // stretch of audio's words on another's timestamps.
      //
      // `segments` is JSON — [{"t0":ms,"t1":ms,"text":"..."}] with CHUNK-RELATIVE timestamps —
      // because whisper returns several timestamped segments per window, not one string.
      //
      // `model` is in the key so changing the weights invalidates every row rather than mixing
      // two models' output into one transcript. Dropped when ASR completes: it is scaffolding,
      // not a record.
      """CREATE TABLE IF NOT EXISTS asr_cache(
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
           model TEXT NOT NULL, segments TEXT NOT NULL,
           PRIMARY KEY (meeting_id, start_ms, end_ms, model));""",
```

- [ ] **Step 2: Add the accessors**

In `AudioDb.kt`, beside `putNote`/`clearNotes`:

```kotlin
  /** One decoded window from the live capture pass. Replaces on conflict: a retry is not a duplicate. */
  fun putCachedWindow(meetingId: String, startMs: Long, endMs: Long, model: String, segments: String) {
    db.execSQL(
      "INSERT OR REPLACE INTO asr_cache(meeting_id,start_ms,end_ms,model,segments) VALUES(?,?,?,?,?)",
      arrayOf<Any?>(meetingId, startMs, endMs, model, segments),
    )
  }

  /** True when this exact window is already decoded, so the live loop can skip it without re-reading it. */
  fun hasCachedWindow(meetingId: String, startMs: Long, endMs: Long, model: String): Boolean {
    db.rawQuery(
      "SELECT 1 FROM asr_cache WHERE meeting_id=? AND start_ms=? AND end_ms=? AND model=? LIMIT 1",
      arrayOf(meetingId, startMs.toString(), endMs.toString(), model),
    ).use { return it.moveToFirst() }
  }

  /**
   * Every cached window for a meeting, as the parallel arrays nativeTranscribe wants:
   * ranges flat as [start0, end0, ...] and one JSON string per window.
   */
  fun cachedWindows(meetingId: String, model: String): Pair<LongArray, Array<String>> {
    val ranges = ArrayList<Long>()
    val json = ArrayList<String>()
    db.rawQuery(
      "SELECT start_ms,end_ms,segments FROM asr_cache WHERE meeting_id=? AND model=? ORDER BY start_ms",
      arrayOf(meetingId, model),
    ).use { c ->
      while (c.moveToNext()) {
        ranges.add(c.getLong(0)); ranges.add(c.getLong(1)); json.add(c.getString(2))
      }
    }
    return Pair(ranges.toLongArray(), json.toTypedArray())
  }

  /** Scaffolding, not a record: dropped once the transcript exists. */
  fun clearCachedWindows(meetingId: String) {
    db.execSQL("DELETE FROM asr_cache WHERE meeting_id=?", arrayOf<Any?>(meetingId))
  }
```

- [ ] **Step 3: Write the test**

Create `android/app/src/test/java/com/innocorelabs/verbale/data/AsrCacheTest.kt`:

```kotlin
package com.innocorelabs.verbale.data

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The cache's contract, at the level that does not need a device: a window is identified by its
 * exact boundaries, and the arrays handed to nativeTranscribe stay parallel and in order.
 *
 * Run on a device-backed database in NativePipelineTest; this pins the shape.
 */
class AsrCacheTest {
  private data class Row(val startMs: Long, val endMs: Long, val model: String, val segments: String)

  // Mirrors the SQL: PRIMARY KEY (meeting_id, start_ms, end_ms, model), ORDER BY start_ms.
  private fun windows(rows: List<Row>, model: String): Pair<LongArray, Array<String>> {
    val kept = rows.filter { it.model == model }.sortedBy { it.startMs }
    val ranges = ArrayList<Long>()
    val json = ArrayList<String>()
    for (r in kept) { ranges.add(r.startMs); ranges.add(r.endMs); json.add(r.segments) }
    return Pair(ranges.toLongArray(), json.toTypedArray())
  }

  @Test
  fun ranges_and_json_stay_parallel_and_ordered() {
    val rows = listOf(
      Row(30000, 55000, "base.en", """[{"t0":0,"t1":500,"text":"again"}]"""),
      Row(0, 30000, "base.en", """[{"t0":0,"t1":1000,"text":"hello"}]"""),
    )
    val (ranges, json) = windows(rows, "base.en")
    assertArrayEquals(longArrayOf(0, 30000, 30000, 55000), ranges)
    assertEquals(2, json.size)
    assertEquals(ranges.size / 2, json.size)
    assertTrue(json[0].contains("hello"))
    assertTrue(json[1].contains("again"))
  }

  @Test
  fun a_different_model_is_a_different_cache() {
    val rows = listOf(Row(0, 30000, "base.en", """[{"t0":0,"t1":1,"text":"x"}]"""))
    assertEquals(1, windows(rows, "base.en").second.size)
    assertEquals(0, windows(rows, "qwen3").second.size)
  }

  @Test
  fun an_empty_cache_yields_empty_arrays() {
    val (ranges, json) = windows(emptyList(), "base.en")
    assertEquals(0, ranges.size)
    assertEquals(0, json.size)
    assertFalse(ranges.isNotEmpty())
  }
}
```

- [ ] **Step 4: Run it**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests "com.innocorelabs.verbale.data.AsrCacheTest"
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt android/app/src/test/java/com/innocorelabs/verbale/data/AsrCacheTest.kt
git commit -m "feat(db): store windows the live pass decoded, keyed on the exact window

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 — orchestration

### Task 8: `LiveBudget` — may it start, should it back off

**Files:**
- Create: `android/.../pipeline/LiveBudget.kt`
- Test: `android/app/src/test/java/com/innocorelabs/verbale/pipeline/LiveBudgetTest.kt`

- [ ] **Step 1: Write the failing test**

Create `android/app/src/test/java/com/innocorelabs/verbale/pipeline/LiveBudgetTest.kt`:

```kotlin
package com.innocorelabs.verbale.pipeline

import android.os.PowerManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The policy, separated from the Android services that supply its inputs so it can be tested.
 *
 * The direction of every decision here is the same: when in doubt, do not run. Backing off costs
 * speed, and the post-hoc pass picks up whatever was missed — but starving the capture or
 * flattening the battery costs the meeting, which is the irreplaceable thing.
 */
class LiveBudgetTest {
  @Test
  fun starts_when_there_is_room() {
    assertTrue(LiveBudget.mayStart(availableBytes = 900L * 1024 * 1024))
  }

  @Test
  fun refuses_when_memory_is_tight() {
    // whisper resident costs ~200 MB; the claim is deliberately conservative.
    assertFalse(LiveBudget.mayStart(availableBytes = 150L * 1024 * 1024))
    assertFalse(LiveBudget.mayStart(availableBytes = 0L))
    assertFalse(LiveBudget.mayStart(availableBytes = -1L))
  }

  @Test
  fun backs_off_when_hot() {
    assertFalse(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_NONE, batteryPercent = 80, charging = false))
    assertFalse(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_LIGHT, batteryPercent = 80, charging = false))
    assertTrue(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_MODERATE, batteryPercent = 80, charging = false))
    assertTrue(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_SEVERE, batteryPercent = 80, charging = false))
  }

  @Test
  fun backs_off_when_the_battery_is_low_unless_charging() {
    assertTrue(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_NONE, batteryPercent = 15, charging = false))
    // On a charger, a low battery is not a reason to stop: it is going up, not down.
    assertFalse(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_NONE, batteryPercent = 15, charging = true))
    // Heat is a reason to stop even on a charger — charging is part of why it is hot.
    assertTrue(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_SEVERE, batteryPercent = 100, charging = true))
  }

  @Test
  fun thread_count_leaves_the_capture_headroom() {
    assertEquals(1, LiveBudget.threadsFor(1))
    assertEquals(1, LiveBudget.threadsFor(2))
    assertEquals(3, LiveBudget.threadsFor(4))
  }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests "com.innocorelabs.verbale.pipeline.LiveBudgetTest"
```

Expected: FAIL — unresolved reference `LiveBudget`.

- [ ] **Step 3: Write it**

Create `android/app/src/main/java/com/innocorelabs/verbale/pipeline/LiveBudget.kt`:

```kotlin
package com.innocorelabs.verbale.pipeline

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager

/**
 * Whether transcribing during a capture is a good idea right now.
 *
 * The live pass is a cache and nothing else, so every decision here is free to be cautious: a
 * refusal costs speed, and the post-hoc pass produces the same transcript either way. What it
 * must never do is compete with the recording. See DiarBudget, which asks the same kind of
 * question about diarization and answers it the same way.
 */
object LiveBudget {
  /**
   * whisper-base resident during a capture, measured generously.
   *
   * ESTIMATED, not measured — the figure to correct once a device run reports real numbers.
   */
  const val WHISPER_RESIDENT_BYTES = 200L * 1024 * 1024

  /** Claim at most half of what is free, so the recorder and the rest of the phone keep theirs. */
  private const val CLAIM_DENOMINATOR = 2L

  /** Below this, stop until the phone is charging or recovers. */
  const val LOW_BATTERY_PERCENT = 20

  fun mayStart(availableBytes: Long): Boolean =
    availableBytes > 0 && WHISPER_RESIDENT_BYTES <= availableBytes / CLAIM_DENOMINATOR

  /**
   * MODERATE is the first status at which Android is actively throttling, and a phone in someone's
   * pocket recording a ninety-minute meeting is exactly where that matters.
   */
  fun shouldBackOff(thermalStatus: Int, batteryPercent: Int, charging: Boolean): Boolean {
    if (thermalStatus >= PowerManager.THERMAL_STATUS_MODERATE) return true
    if (!charging && batteryPercent in 0 until LOW_BATTERY_PERCENT) return true
    return false
  }

  /**
   * One fewer thread than the pipeline uses, so the capture thread always has somewhere to run.
   *
   * A PRECAUTION, not a measurement. If the device run in the plan shows capture is untroubled,
   * this can go back to the full count — but the failure it guards against is dropped audio,
   * which is unrecoverable, so it stays until there is evidence.
   */
  fun threadsFor(inferenceThreads: Int): Int = maxOf(1, inferenceThreads - 1)

  fun availableBytes(ctx: Context): Long {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val mi = ActivityManager.MemoryInfo()
    am.getMemoryInfo(mi)
    return mi.availMem - mi.threshold
  }

  fun thermalStatus(ctx: Context): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return PowerManager.THERMAL_STATUS_NONE
    val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
    return pm.currentThermalStatus
  }

  fun batteryPercent(ctx: Context): Int {
    val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    return if (pct in 0..100) pct else 100
  }

  fun isCharging(ctx: Context): Boolean {
    val status = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      ?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
    return status == BatteryManager.BATTERY_STATUS_CHARGING ||
      status == BatteryManager.BATTERY_STATUS_FULL
  }

  fun describe(availableBytes: Long, thermal: Int, battery: Int, charging: Boolean): String =
    "free=${availableBytes / 1024 / 1024}MB thermal=$thermal battery=$battery% charging=$charging"
}
```

- [ ] **Step 4: Run the test**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests "com.innocorelabs.verbale.pipeline.LiveBudgetTest"
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/pipeline/LiveBudget.kt android/app/src/test/java/com/innocorelabs/verbale/pipeline/LiveBudgetTest.kt
git commit -m "feat(live): decide when transcribing during a capture is a good idea

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `LiveTranscriber` — the loop

**Files:**
- Create: `android/.../pipeline/LiveTranscriber.kt`

- [ ] **Step 1: Write it**

Create `android/app/src/main/java/com/innocorelabs/verbale/pipeline/LiveTranscriber.kt`:

```kotlin
package com.innocorelabs.verbale.pipeline

import android.content.Context
import android.util.Log
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ModelCatalog
import java.io.File

/**
 * Transcribes a meeting WHILE it is being recorded, so the wait after "stop" is roughly halved.
 *
 * It tails the PCM file rather than tapping the capture thread. That is the whole safety story:
 * the recorder's loop is untouched, so ASR cannot starve it even in principle, and audio the user
 * paused — discarded, never written — is simply audio this reader never sees.
 *
 * Nothing here decides anything. It decodes windows and stores them; the post-hoc pipeline still
 * runs in full and still owns language refusal, alignment and minutes. A window this class fails
 * to reach is decoded later exactly as it always was, so every failure path degrades to the
 * behaviour that shipped before this file existed.
 *
 * See docs/superpowers/specs/2026-09-07-live-transcript-design.md.
 */
class LiveTranscriber(
  private val ctx: Context,
  private val meetingId: String,
  private val audioPath: String,
) {
  companion object {
    private const val TAG = "LiveTranscriber"

    /** Feed the VAD in ten-second bites: big enough to amortise the JNI call, well under the 12 s lookahead. */
    private const val FEED_MS = 10_000L
    private const val IDLE_SLEEP_MS = 1_000L
    private const val BACKOFF_SLEEP_MS = 5_000L
  }

  @Volatile private var running = false
  private var worker: Thread? = null

  fun start() {
    if (running) return
    val db = AudioDb.get(ctx)
    // The SAME expressions ProcessingEngine uses, deliberately. The cache key is the model's file
    // name, so if these two ever resolve differently every window misses and nothing fails —
    // it would just look as though the live pass never helped. ProcessingService constructs
    // ProcessingEngine with "base"; that literal is the coupling, and it lives in both places.
    val asrFile = ModelCatalog.fileFor(ctx, ModelCatalog.asrIdForModel("base"))
    val vadFile = File(File(ctx.filesDir, "models"), "silero_vad.onnx")
    if (asrFile == null || !asrFile.exists() || !vadFile.exists()) {
      Log.i(TAG, "not starting: models not installed")
      return
    }
    val free = LiveBudget.availableBytes(ctx)
    if (!LiveBudget.mayStart(free)) {
      Log.i(TAG, "not starting: ${LiveBudget.describe(free, 0, 100, false)}")
      return
    }
    running = true
    worker = Thread({ run(db, vadFile.absolutePath, asrFile.absolutePath) }, "audionotes-live").apply {
      // Below the capture thread on purpose. If the scheduler ever has to choose, the microphone
      // wins; losing a window here costs a cache entry, losing audio costs the meeting.
      priority = Thread.MIN_PRIORITY
      start()
    }
  }

  /** Ends the loop. Does NOT block: whatever was cached is already committed, row by row. */
  fun stop() {
    running = false
  }

  private fun run(db: AudioDb, vadModel: String, asrModel: String) {
    var vad = 0L
    var asr = 0L
    val model = File(asrModel).name
    val threads = LiveBudget.threadsFor(Runtime.getRuntime().availableProcessors().coerceAtMost(4))
    val spans = ArrayList<Long>()
    var tailBytes = 0L
    var cached = 0

    try {
      vad = NativeBridge.nativeVadOpen(vadModel, RecordingService.SAMPLE_RATE)
      asr = NativeBridge.nativeAsrOpen(asrModel, "en")
      if (vad == 0L || asr == 0L) {
        Log.w(TAG, "native handles unavailable (vad=$vad asr=$asr)")
        return
      }

      while (running) {
        if (backOff()) { Thread.sleep(BACKOFF_SLEEP_MS); continue }

        val size = File(audioPath).length()
        val grown = size - tailBytes
        if (grown < FEED_MS * RecordingService.BYTES_PER_MS) { Thread.sleep(IDLE_SLEEP_MS); continue }

        for (v in NativeBridge.nativeVadFeed(vad, audioPath, tailBytes, grown)) spans.add(v)
        tailBytes += grown
        cached += decodeReadyWindows(db, asr, spans, vad, tailBytes, model, threads)
      }

      // Capture is over. Drain whatever is left, then let the last windows go final.
      val size = File(audioPath).length()
      if (size > tailBytes) {
        for (v in NativeBridge.nativeVadFeed(vad, audioPath, tailBytes, size - tailBytes)) spans.add(v)
        tailBytes = size
      }
      for (v in NativeBridge.nativeVadFinish(vad)) spans.add(v)
      cached += decodeReadyWindows(db, asr, spans, vad, Long.MAX_VALUE / 2, model, threads)
      Log.i(TAG, "cached $cached window(s) for $meetingId")
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
    } catch (e: Throwable) {
      // Never fatal. A live pass that dies costs cache hits; the meeting is unaffected.
      Log.w(TAG, "live pass ended early", e)
    } finally {
      if (asr != 0L) NativeBridge.nativeAsrClose(asr)
      if (vad != 0L) NativeBridge.nativeVadClose(vad)
      running = false
    }
  }

  /** Decode every window that can no longer change and is not already stored. Returns how many. */
  private fun decodeReadyWindows(
    db: AudioDb, asr: Long, spans: ArrayList<Long>, vad: Long,
    capturedBytes: Long, model: String, threads: Int,
  ): Int {
    val capturedMs =
      if (capturedBytes == Long.MAX_VALUE / 2) Long.MAX_VALUE / 2
      else capturedBytes / RecordingService.BYTES_PER_MS
    val pending = NativeBridge.nativeVadPendingSpanStartMs(vad)
    val chunks = NativeBridge.nativeLiveChunks(spans.toLongArray(), pending, capturedMs)
    var n = 0
    var i = 0
    while (i + 1 < chunks.size) {
      if (!running && capturedBytes != Long.MAX_VALUE / 2) break
      val startMs = chunks[i]
      val endMs = chunks[i + 1]
      i += 2
      if (db.hasCachedWindow(meetingId, startMs, endMs, model)) continue
      if (backOff()) break
      val json = NativeBridge.nativeAsrDecodeWindow(
        asr, audioPath, RecordingService.SAMPLE_RATE, startMs, endMs, threads,
      )
      // "[]" is stored too: a window that genuinely decoded to nothing is a result, and storing it
      // stops the loop retrying it every pass.
      db.putCachedWindow(meetingId, startMs, endMs, model, json)
      n++
    }
    return n
  }

  private fun backOff(): Boolean = LiveBudget.shouldBackOff(
    LiveBudget.thermalStatus(ctx), LiveBudget.batteryPercent(ctx), LiveBudget.isCharging(ctx),
  )
}
```

- [ ] **Step 2: Build**

```bash
cd android && ./gradlew :app:assembleDebug
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/pipeline/LiveTranscriber.kt
git commit -m "feat(live): tail the recording and decode windows as they settle

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Run it during the capture

**Files:**
- Modify: `android/.../pipeline/RecordingService.kt`

- [ ] **Step 1: Hold one**

In `RecordingService.kt`, beside the other `@Volatile` fields near line 79:

```kotlin
  /**
   * Transcribes while we record, so the wait after "stop" is roughly halved. Started after the
   * capture loop is live and stopped in onDestroy. It only ever reads the PCM file, so it cannot
   * interfere with the write above it.
   */
  private var live: LiveTranscriber? = null
```

- [ ] **Step 2: Start it once the capture loop is running**

In `startCapture`, immediately after the `worker = thread(name = "audionotes-capture") { ... }`
block closes (after the whole `thread {}` assignment, not inside it), add:

```kotlin
    // After the capture thread exists, deliberately: this reads the file that thread writes, and
    // starting it first would just spin on an empty file. Its own budget check decides whether it
    // actually runs, and a refusal is silent by design — nothing about the recording changes.
    meetingId?.let { id ->
      live = LiveTranscriber(applicationContext, id, path).also { it.start() }
    }
```

- [ ] **Step 3: Stop it on teardown**

In `onDestroy`, as the FIRST statement of the method:

```kotlin
    // Before the capture teardown below: this only sets a flag, and the loop drains the tail of
    // the file on its way out, so stopping it early costs nothing and leaves it nothing to race.
    live?.stop()
    live = null
```

- [ ] **Step 4: Build**

```bash
cd android && ./gradlew :app:assembleDebug
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/pipeline/RecordingService.kt
git commit -m "feat(capture): run the live pass alongside the recording

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Use the cache, then drop it

**Files:**
- Modify: `android/.../pipeline/ProcessingEngine.kt:107-175`

- [ ] **Step 1: Pass the cache into the ASR call**

In `ProcessingEngine.kt`, immediately before the `NativeBridge.nativeTranscribe(` call around line
129, insert:

```kotlin
          // Windows the live pass already decoded during the capture. Whisper uses one only when
          // the boundaries match exactly, so a cache built against different VAD spans costs a
          // decode and never a wrong word. See the live-transcript design doc.
          val (cachedRanges, cachedJson) = db.cachedWindows(meetingId, asrFile.name)
          if (cachedRanges.isNotEmpty()) {
            Log.i(TAG, "live pass offers ${cachedJson.size} window(s) for $meetingId")
          }
```

and extend the `nativeTranscribe(` call. It passes its arguments positionally today, so append
the two new ones in order — the last line becomes:

```kotlin
            if (qwen3Dir.isDirectory) qwen3Dir.absolutePath else "", forced,
            cachedRanges, cachedJson,
```

- [ ] **Step 2: Drop the cache once the transcript exists**

Immediately after the line that marks ASR complete — the `listener.onStage("asr", 1, 1)` at line
151, the success path, NOT the one at 175 — add:

```kotlin
            // Scaffolding, not a record. Once utterances exist its only remaining use is making a
            // Redo faster, and Redo is explicitly a request to recompute. Keeping it would leave a
            // second copy of transcript text to honour in retention, exports and the privacy
            // summary. Deleting is the smaller promise.
            db.clearCachedWindows(meetingId)
```

- [ ] **Step 3: Confirm `File` is imported**

```bash
grep -n "^import java.io.File" android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt
```

Expected: one line. It is already used for `File(audioPath).length()` in the diarize block, so it
should be present; add it if not.

- [ ] **Step 4: Build and run the unit tests**

```bash
cd android && ./gradlew :app:assembleDebug :app:testDebugUnitTest
```

Expected: BUILD SUCCESSFUL, all unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt
git commit -m "feat(processing): take the live pass's windows, then drop them

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Phase 5 — guards and verification

### Task 12: A guard for the invariant that would fail silently

**Files:**
- Create: `scripts/check-live-transcript.py`
- Modify: `cpp/cli/CMakeLists.txt`

- [ ] **Step 1: Write the guard**

Create `scripts/check-live-transcript.py`:

```python
#!/usr/bin/env python3
"""The live pass is a CACHE. It must never write the pipeline's own rows.

The whole safety argument rests on this: because the live pass only pre-computes decodes that the
post-hoc pipeline is free to ignore, a slow phone, a thermal backoff or a crash mid-meeting all
degrade to the behaviour that shipped before it existed. The moment it writes utterances,
segments or speakers, a PARTIAL live pass starts to look like a COMPLETE stage to ResumePlan --
which skips it -- and the tail of the meeting is silently lost.

Nothing fails when that invariant breaks. The transcript is simply short. Hence a grep.

See docs/superpowers/specs/2026-09-07-live-transcript-design.md section 2.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LIVE = ROOT / "android/app/src/main/java/com/innocorelabs/verbale/pipeline/LiveTranscriber.kt"

# Writers the live pass must not call. Reading is fine; these all COMMIT pipeline state.
FORBIDDEN = [
    "insertUtterances",
    "insertSegments",
    "insertSpeakers",
    "setStatus",
    "assignSpeakers",
    "putNote",
    "markProcessed",
]

def main() -> int:
    if not LIVE.exists():
        print(f"FAIL: {LIVE.relative_to(ROOT)} is missing", file=sys.stderr)
        return 1

    src = LIVE.read_text(encoding="utf-8")
    bad = [name for name in FORBIDDEN if re.search(r"\b%s\s*\(" % re.escape(name), src)]
    if bad:
        print(
            "FAIL: LiveTranscriber commits pipeline state: " + ", ".join(sorted(bad)) + "\n"
            "The live pass must only write asr_cache. A partial pass that writes utterances "
            "makes ResumePlan skip Stage.ASR and silently loses the rest of the meeting.",
            file=sys.stderr,
        )
        return 1

    # It must actually be a cache writer, or the guard is passing on an empty file.
    if "putCachedWindow" not in src:
        print("FAIL: LiveTranscriber never calls putCachedWindow", file=sys.stderr)
        return 1

    print("live transcript: cache-only invariant holds")
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Wire it into ctest**

In `cpp/cli/CMakeLists.txt`, immediately after the `add_test(NAME diar_constants ...)` block:

```cmake
# The live capture pass must only ever write its cache. If it writes utterances instead, a pass
# that covered 80% of a meeting looks COMPLETE to ResumePlan, Stage.ASR is skipped, and the last
# eighteen minutes vanish with nothing failing.
add_test(NAME live_transcript_cache_only
         COMMAND python3 ${REPO_ROOT}/scripts/check-live-transcript.py)
```

- [ ] **Step 3: Prove it fails when it should**

```bash
chmod +x scripts/check-live-transcript.py && python3 scripts/check-live-transcript.py
# Now plant a violation and confirm it is caught:
sed -i.bak 's/db.putCachedWindow(meetingId, startMs, endMs, model, json)/db.insertUtterances(meetingId, emptyList()); db.putCachedWindow(meetingId, startMs, endMs, model, json)/' \
  android/app/src/main/java/com/innocorelabs/verbale/pipeline/LiveTranscriber.kt
python3 scripts/check-live-transcript.py; echo "exit=$?"
mv android/app/src/main/java/com/innocorelabs/verbale/pipeline/LiveTranscriber.kt.bak \
   android/app/src/main/java/com/innocorelabs/verbale/pipeline/LiveTranscriber.kt
python3 scripts/check-live-transcript.py
```

Expected: passes, then `exit=1` with the insertUtterances message, then passes again. A guard
never seen to fail is not a guard.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-live-transcript.py cpp/cli/CMakeLists.txt
git commit -m "test(live): fail the build if the live pass ever commits pipeline state

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Prove a warm cache and a cold one give the same transcript

**Files:**
- Modify: `cpp/cli/main.cpp`, `eval/run.py`

- [ ] **Step 1: Let the pipeline carry a cache**

In `cpp/pipeline/pipeline.h`, add to `struct PipelineConfig`, after `diar_speaker_threshold`:

```cpp
  // Windows already decoded elsewhere. On Android this is the live capture pass; in the CLI it is
  // --live-cache, which exists so a warm run and a cold run can be proved to produce the same
  // transcript rather than merely a similar one.
  std::vector<AsrCachedWindow> chunk_cache;
```

and `#include "asr/asr_engine.h"` is already present via `asr/asr_engine.h` — confirm with
`grep -n 'asr/asr_engine.h' cpp/pipeline/pipeline.h`.

In `cpp/pipeline/pipeline.cpp`, after line 129 (`acfg.skip_language_refusal = ...`):

```cpp
    acfg.chunk_cache = cfg_.chunk_cache;
```

- [ ] **Step 2: Add the CLI flag**

In `cpp/cli/main.cpp`, add to the usage text beneath the `--diar-speaker-threshold` line (~line 85):

```cpp
                 "          [--live-cache]         pre-decode every window, then run from cache\n"
```

Declare the flag beside the other option variables:

```cpp
  bool live_cache = false;
```

Parse it beside the other flags (~line 115):

```cpp
    else if (std::strcmp(argv[i], "--live-cache") == 0) live_cache = true;
```

Then, immediately before the `Pipeline` is constructed and run, add the pre-pass:

```cpp
  // Simulate what the live capture pass does: VAD the file, chunk it exactly as the pipeline
  // will, decode every window through the SAME decodeWindow the pipeline uses, and hand the
  // results back as a cache. If the transcript then differs from a cold run by a single
  // character, the cache is not the pure function the whole design rests on.
  if (live_cache) {
    audionotes::SileroVad vad(cfg.vad_model, cfg.sample_rate);
    const std::vector<audionotes::Segment> spans = vad.process(pcm_path);
    audionotes::WhisperAsr warm(cfg.asr_model, cfg.language, cfg.skip_language_refusal);
    if (!warm.ok()) {
      std::fprintf(stderr, "--live-cache: whisper model failed to load\n");
      return 1;
    }
    for (const audionotes::Chunk& c : audionotes::makeChunks(spans, warm.maxChunkMs())) {
      audionotes::AsrCachedWindow w;
      w.start_ms = c.start_ms;
      w.end_ms = c.end_ms;
      w.utterances = warm.decodeWindow(pcm_path, cfg.sample_rate, c.start_ms, c.end_ms,
                                       cfg.asr_threads);
      cfg.chunk_cache.push_back(std::move(w));
    }
    std::fprintf(stderr, "--live-cache: pre-decoded %zu window(s)\n", cfg.chunk_cache.size());
  }
```

Add `#include "asr/whisper_asr.h"`, `#include "asr/asr_chunker.h"` and `#include "vad/silero_vad.h"`
to the top of `main.cpp` if they are not already there.

- [ ] **Step 3: Pass the flag through the eval harness**

In `eval/run.py`, beside the existing `--diar-window-min` / `--diar-speaker-threshold` handling,
add an argparse flag and forward it:

```python
    ap.add_argument("--live-cache", action="store_true",
                    help="pre-decode every window and run the pipeline from that cache; "
                         "the transcript must come out identical to a cold run")
    ...
    if args.live_cache:
        cmd.append("--live-cache")
```

- [ ] **Step 4: Build**

```bash
cd cpp/cli/build && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake --build . -j8
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 5: Run one fixture both ways and diff**

```bash
cd cpp/cli/build && /Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake --build . -j8
cd ../../../eval
python3 run.py --fixture ES2002a --out /tmp/cold.json
python3 run.py --fixture ES2002a --live-cache --out /tmp/warm.json
python3 - <<'EOF'
import json
cold = json.load(open('/tmp/cold.json'))
warm = json.load(open('/tmp/warm.json'))
a = [(u['start_ms'], u['end_ms'], u['text']) for u in cold['transcript']]
b = [(u['start_ms'], u['end_ms'], u['text']) for u in warm['transcript']]
print(f"cold {len(a)} utterances, warm {len(b)}")
assert a == b, "TRANSCRIPTS DIFFER — the cache is not returning the same value"
print("IDENTICAL")
EOF
```

Expected: `IDENTICAL`. Not "WER is close" — identical tuples. If this fails, the cache is not the
pure function the whole design rests on, and the cause must be found before shipping.

- [ ] **Step 6: Repeat across all four fixtures**

```bash
cd eval && for f in ES2002a ES2002b IS1000a ES2003a; do
  python3 run.py --fixture $f --out /tmp/cold-$f.json
  python3 run.py --fixture $f --live-cache --out /tmp/warm-$f.json
  python3 -c "
import json,sys
c=json.load(open('/tmp/cold-$f.json'))['transcript']
w=json.load(open('/tmp/warm-$f.json'))['transcript']
same=[(u['start_ms'],u['end_ms'],u['text']) for u in c]==[(u['start_ms'],u['end_ms'],u['text']) for u in w]
print('$f', 'IDENTICAL' if same else 'DIFFERS'); sys.exit(0 if same else 1)"
done
```

Expected: four `IDENTICAL` lines.

- [ ] **Step 7: Commit**

```bash
git add cpp/cli/main.cpp cpp/pipeline/pipeline.h cpp/pipeline/pipeline.cpp eval/run.py
git commit -m "test(live): prove a warm cache and a cold one produce the same transcript

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: The device gate

**Files:** none — this is verification.

- [ ] **Step 1: Run the existing device suite**

```bash
npm run test:device
```

Expected: 16 tests, 0 skips. **Never run `./gradlew connectedDebugAndroidTest`** — it uninstalls
the app and wipes the downloaded models and the recordings database.

- [ ] **Step 2: Record a short meeting and confirm the live pass ran**

```bash
$ANDROID_HOME/platform-tools/adb logcat -c
# Record ~3 minutes of speech in the app, then stop and let it process.
$ANDROID_HOME/platform-tools/adb logcat -d | grep -E "LiveTranscriber|live pass offers|announcement check"
```

Expected: a `LiveTranscriber: cached N window(s)` line with N > 0, a
`live pass offers N window(s)` line from ProcessingEngine, and the announcement check still
reporting `heard=true`. The announcement reads the first 12 s straight from the capture loop and
is the most timing-sensitive thing in the service, so it is the canary for capture disturbance.

- [ ] **Step 3: Confirm no audio was dropped**

```bash
$ANDROID_HOME/platform-tools/adb shell run-as com.innocorelabs.verbale \
  ls -l files/meetings/ | tail -3
```

Take the newest meeting's `audio.pcm` size, divide by 32000 for seconds, and compare with the
duration the app displayed. Expected: within a second. A shortfall means the live pass starved the
recorder, which is the one outcome that invalidates the design and must stop the work.

- [ ] **Step 4: Measure the saving**

Record a meeting of at least 20 minutes, note the wall clock between pressing stop and the "Notes
ready" notification, and compare with the ~1.2x realtime baseline in
`docs/NEXT.md` item 5. Expected: roughly 0.65x realtime, since ASR should now be mostly cached and
diarization is what remains.

- [ ] **Step 5: Update the checklist**

Add the measured numbers to `docs/NEXT.md` §4 item 1 and mark it done, then commit.

```bash
git add docs/NEXT.md
git commit -m "docs: record what the live pass actually saved on device

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Known gaps this plan does not close

- **The A07's ASR realtime factor is still unmeasured.** If whisper runs slower than 1.0x realtime
  on a cheap phone, the live pass never catches up. It stays correct — it just does not help.
  Task 14 measures the Pixel; the A07 needs the same treatment and may change how `FEED_MS` and
  the thread cap are set.
- **`LiveBudget.WHISPER_RESIDENT_BYTES` is an estimate**, and `LiveBudget.threadsFor` is a
  precaution rather than a measurement. Both should be revisited with the numbers Task 14 produces.
- **Two VAD runs per meeting.** Defended in the spec on partial-completion grounds; costs about a
  minute on a 90-minute meeting.
- **Diarization is untouched** and becomes essentially the whole remaining wait. That is the next
  spec, not this one.
