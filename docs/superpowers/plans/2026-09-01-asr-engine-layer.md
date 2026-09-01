# ASR Engine Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-engine ASR path into a layer with one interface, two engines (whisper and Qwen3-ASR), a correct shared chunker and one normalisation stage — without changing whisper's output until the commit that means to.

**Architecture:** `AsrEngine` is an abstract interface returning an `AsrRun`. `makeAsrEngine` routes by requested language through an explicit policy table. A shared chunker turns VAD spans into decode windows honouring each engine's declared budget and chunking mode; a shared post-process stage scrubs every engine's output. Whisper's behaviour is pinned by tests before any of it moves.

**Tech Stack:** C++17, whisper.cpp, sherpa-onnx (Qwen3-ASR + ONNX Runtime), CMake + Ninja + ctest, Python 3 for the eval harness.

**Spec:** `docs/superpowers/specs/2026-09-01-asr-engine-layer-design.md`

---

## Before you start

`cmake`, `ninja` and `ctest` are **not on PATH**. They come from the Android SDK. Every task below
assumes this has been exported in your shell:

```bash
export PATH="/Users/akshayghosh/Library/Android/sdk/cmake/3.22.1/bin:$PATH"
cd /Users/akshayghosh/ReactNative/InnoCoreLabs/AudioNotes
```

The three commands you will run constantly:

```bash
# Reconfigure — only needed after editing cpp/cli/CMakeLists.txt
cmake -S cpp/cli -B cpp/cli/build -G Ninja

# Build
cmake --build cpp/cli/build

# Test
ctest --test-dir cpp/cli/build --output-on-failure
```

Baseline before you touch anything: **6 tests, all passing** (`test_utf8`, `test_minutes`,
`test_llm_minutes`, `test_pipeline_align`, `test_cancel`, `test_capi`). If they are not green
before you start, stop and find out why — you cannot prove a refactor changed nothing against a
red baseline.

Models and fixtures are already on this machine: `eval/models/` (whisper base + small, silero,
diar pair, Qwen LLM, judge) and `eval/fixtures/` (four AMI meetings, two real recordings).

### Two things that will bite you

1. **ggml ownership.** llama.cpp and whisper.cpp both vendor ggml under the same target names.
   llama must be `add_subdirectory`'d first. Do not reorder anything in either CMakeLists.
2. **sherpa segfaults on unreadable model paths.** It does not return null — it dereferences a
   null internal pointer and takes the process down. Every path handed to sherpa must go through
   a readability check first. `Diarizer::Impl::readable` (`cpp/diar/diarizer.cpp:56-68`) is the
   existing precedent; Task 6 reuses that shape.

---

## File Structure

| File | Responsibility |
|---|---|
| `cpp/asr/asr_engine.h` | **Create.** `Utterance`, `AsrRun`, `AsrConfig`, `ChunkMode`, the `AsrEngine` interface, `makeAsrEngine` declaration |
| `cpp/asr/asr_factory.cpp` | **Create.** The language→engine policy table and fallback. The only place that maps a language to a class |
| `cpp/asr/asr_chunker.h/.cpp` | **Create.** VAD spans → decode windows, honouring budget and chunk mode |
| `cpp/asr/asr_postprocess.h/.cpp` | **Create.** UTF-8 scrub, leading-space trim, dialogue dash — applied to every engine |
| `cpp/asr/qwen3_asr.h/.cpp` | **Create.** Qwen3-ASR over sherpa's offline recognizer |
| `cpp/asr/whisper_asr.h/.cpp` | **Modify.** Implements `AsrEngine`; loses the type declarations, its private chunker and its inline scrubbing |
| `cpp/tests/test_asr_chunker.cpp` | **Create.** Pins chunker behaviour, including the defect |
| `cpp/tests/test_asr_postprocess.cpp` | **Create.** Pins normalisation |
| `cpp/tests/test_asr_factory.cpp` | **Create.** Pins routing and fallback |
| `eval/characterize.py` | **Create.** Records and diffs the CLI's full output. Needs real weights, so not a ctest |
| `cpp/cli/CMakeLists.txt` | **Modify.** New sources into every target; three new tests |
| `cpp/CMakeLists.txt` | **Modify.** New sources into the Android library |
| `cpp/pipeline/pipeline.h/.cpp` | **Modify.** Build through the factory; `Utterance` now from `asr_engine.h` |
| `cpp/jni/audionotes_jni.cpp` | **Modify.** Build through the factory |
| `cpp/cli/main.cpp` | **Modify.** `--asr-engine`, `--qwen3-model`; language default |
| `eval/run.py` | **Modify.** `--asr-engine`, script histogram in results |

---

## Task 0: Default the language to English

Independent of everything else and worth landing first — it is the cheapest real quality win
available, and `auto` re-detecting per chunk is the original bug.

**Files:**
- Modify: `cpp/asr/whisper_asr.h:33`
- Modify: `cpp/pipeline/pipeline.h` (`PipelineConfig::language`)
- Modify: `cpp/cli/main.cpp:94`
- Modify: `cpp/jni/audionotes_jni.cpp:88-89`
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt:118`
- Modify: `src/screens/SettingsScreen.tsx:325`
- Test: `cpp/tests/test_pipeline_align.cpp`

- [ ] **Step 1: Write the failing test**

Add to the top of `main()` in `cpp/tests/test_pipeline_align.cpp`:

```cpp
  // The shipped default. `auto` re-detects the language every chunk, which is what returned one
  // meeting in five scripts including Korean and Chinese. Pinned so it cannot drift back.
  {
    audionotes::PipelineConfig cfg;
    CHECK(cfg.language == "en", "default language is '%s', want 'en'", cfg.language.c_str());
  }
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cmake --build cpp/cli/build && ctest --test-dir cpp/cli/build -R test_pipeline_align --output-on-failure
```

Expected: FAIL, `default language is 'auto', want 'en'`.

- [ ] **Step 3: Change the six defaults**

```bash
sed -i '' 's|const std::string& language = "auto"|const std::string\& language = "en"|' cpp/asr/whisper_asr.h
sed -i '' 's|std::string language = "auto";|std::string language = "en";|' cpp/pipeline/pipeline.h
sed -i '' 's|std::string language = "auto";|std::string language = "en";|' cpp/cli/main.cpp
sed -i '' 's|if (language.empty()) language = "auto";|if (language.empty()) language = "en";|' cpp/jni/audionotes_jni.cpp
sed -i '' 's|db.getSetting("asrLanguage")?.takeIf { it.isNotBlank() } ?: "auto"|db.getSetting("asrLanguage")?.takeIf { it.isNotBlank() } ?: "en"|' android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt
sed -i '' "s|.then(v => setLanguage(v ?? 'auto'))|.then(v => setLanguage(v ?? 'en'))|" src/screens/SettingsScreen.tsx
```

Then update the comment on `whisper_asr.h:29-32` — it currently explains why `auto` is the
default, which will no longer be true. Replace the last sentence ("Pin it when the language is
known.") with:

```
  // Defaults to "en": most first meetings are in English, and per-chunk re-detection is the bug
  // above rather than a feature. Any other language is pinned the same way — this layer never
  // asks an engine to emit one language for audio in another.
```

- [ ] **Step 4: Verify green**

```bash
cmake --build cpp/cli/build && ctest --test-dir cpp/cli/build --output-on-failure
```

Expected: 6/6 pass.

- [ ] **Step 5: Verify nothing else still says auto**

```bash
grep -rn '"auto"' cpp/asr cpp/pipeline cpp/cli/main.cpp cpp/jni android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt
```

Expected: only comments and the `--language en|hi|auto` usage string. `auto` remains *available*;
it is just no longer the default.

- [ ] **Step 6: Commit**

```bash
git add -A cpp/ android/ src/screens/SettingsScreen.tsx
git commit -m "fix(asr): default to English instead of re-detecting every chunk

Whisper with no_context re-decides the language per 30s window, which returned
one Hindi/English meeting in five scripts including Korean and Chinese. English
is the default because most first meetings are in English — not because other
languages are second-class: every language is pinned the same way, and the layer
never asks an engine to emit one language for audio in another.

Applies to installs that never chose explicitly, which is the point: auto is the
broken state, so leaving existing users on it would keep the bug exactly where it
is already being felt."
```

---

## Task 1: Characterization harness

Proves Tasks 2-5 changed nothing. Needs real weights, so it is a script run by hand — not a
ctest. A test that silently skips because weights are missing is a test that lies.

**Files:**
- Create: `eval/characterize.py`
- Create: `eval/baseline/` (output, git-tracked)

- [ ] **Step 1: Write the script**

```python
#!/usr/bin/env python3
"""Pin the CLI's exact transcript so a refactor can prove it changed nothing.

Not a ctest: it needs 60 MB of whisper weights and a real fixture. Run it once before a refactor
with --record, then again after with no flag. Any diff is a regression.

Determinism: whisper here is greedy, and thread count comes from inferenceThreadCount(), which
reads CPU topology. That makes output reproducible ON ONE MACHINE but not necessarily across
machines — so a baseline is only meaningful compared against itself on the same hardware.
"""
import argparse, json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, "cpp", "cli", "build", "audionotes_cli")
MODELS = os.path.join(ROOT, "eval", "models")
BASELINE = os.path.join(ROOT, "eval", "baseline")

# Two fixtures, chosen deliberately: one clean English meeting, and the Hindi/English recording
# that started all of this. A refactor that breaks only one of them is the interesting case.
FIXTURES = ["ES2002a", "real-neosym-2026-08-19"]


def run(fixture, language):
    """Transcript only — no diarization, no LLM. Fewer moving parts is the whole point here."""
    fixture_dir = os.path.join(ROOT, "eval", "fixtures", fixture)
    out = os.path.join("/tmp", f"characterize-{fixture}.json")
    cmd = [CLI,
           os.path.join(MODELS, "ggml-base-q5_1.bin"),
           os.path.join(fixture_dir, "audio.wav"),
           "--vad", os.path.join(MODELS, "silero_vad.onnx"),
           "--language", language,
           "--json", out]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
    with open(out) as f:
        doc = json.load(f)
    # Only the transcript. Timings are wall-clock and would differ on every run.
    return [{"start_ms": u["start_ms"], "end_ms": u["end_ms"], "text": u["text"]}
            for u in doc.get("transcript", [])]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--record", action="store_true", help="write the baseline instead of diffing")
    ap.add_argument("--language", default="en")
    args = ap.parse_args()

    os.makedirs(BASELINE, exist_ok=True)
    failures = 0
    for fx in FIXTURES:
        got = run(fx, args.language)
        path = os.path.join(BASELINE, f"{fx}.json")
        if args.record:
            with open(path, "w") as f:
                json.dump(got, f, indent=1, ensure_ascii=False)
            print(f"recorded {fx}: {len(got)} utterances")
            continue
        if not os.path.exists(path):
            print(f"NO BASELINE for {fx} — run with --record first", file=sys.stderr)
            failures += 1
            continue
        with open(path) as f:
            want = json.load(f)
        if got == want:
            print(f"OK {fx}: {len(got)} utterances identical")
        else:
            failures += 1
            print(f"DIFF {fx}: baseline {len(want)} utterances, got {len(got)}", file=sys.stderr)
            for i, (a, b) in enumerate(zip(want, got)):
                if a != b:
                    print(f"  first diff at {i}:\n    was {a}\n    now {b}", file=sys.stderr)
                    break
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Record the baseline**

```bash
python3 eval/characterize.py --record
```

Expected: two `recorded <fixture>: N utterances` lines, N > 0 for both. **If either is 0, stop** —
something is wrong with the CLI or the fixture, and a baseline of nothing proves nothing.

- [ ] **Step 3: Verify it detects itself**

```bash
python3 eval/characterize.py
```

Expected: two `OK` lines, exit 0.

- [ ] **Step 4: Verify it can actually fail**

Temporarily corrupt one baseline and confirm the script notices:

```bash
python3 -c "
import json; p='eval/baseline/ES2002a.json'
d=json.load(open(p)); d[0]['text']='SENTINEL'; json.dump(d,open(p,'w'),indent=1,ensure_ascii=False)"
python3 eval/characterize.py; echo "exit=$?"
```

Expected: `DIFF ES2002a`, `exit=1`. A characterization harness that cannot fail is worse than
none — it grants false confidence to every task after this one. Then restore:

```bash
python3 eval/characterize.py --record && python3 eval/characterize.py
```

- [ ] **Step 5: Commit**

```bash
git add eval/characterize.py eval/baseline/
git commit -m "test(asr): pin the CLI's exact transcript before restructuring it

There are no ASR characterization tests — cpp/tests/golden is entirely
minutes_*.json — so the ASR refactor has nothing to prove itself against.

Deliberately not a ctest: it needs 60MB of weights, and a test that skips when
they are absent is a test that lies. Run by hand before and after.

Two fixtures on purpose: one clean English meeting and the Hindi/English
recording that prompted this work. Step 4 of the plan verifies the harness can
actually fail, because one that cannot would grant false confidence to every
commit that follows."
```

---

## Task 2: Extract the chunker, unchanged, and pin it

The extraction is mechanical and the behaviour — including the defect — is preserved exactly.
The defect is pinned *as a test assertion* so Task 7's fix appears as an intentional diff.

**Files:**
- Create: `cpp/asr/asr_chunker.h`, `cpp/asr/asr_chunker.cpp`
- Create: `cpp/tests/test_asr_chunker.cpp`
- Modify: `cpp/asr/whisper_asr.cpp:47-59` (remove the private `makeChunks`), `:102`
- Modify: `cpp/cli/CMakeLists.txt`, `cpp/CMakeLists.txt`

- [ ] **Step 1: Write `cpp/asr/asr_chunker.h`**

```cpp
// How VAD speech spans become the windows an ASR engine decodes.
//
// Lifted out of whisper_asr.cpp unchanged. It lives here because two engines now need it and
// because their numbers are only comparable if they see identical boundaries — a WER gap that is
// really a chunking artefact would be worse than no measurement at all.
#pragma once
#include <cstdint>
#include <vector>

#include "vad/silero_vad.h"  // Segment

namespace audionotes {

struct Chunk {
  int64_t start_ms;
  int64_t end_ms;
};

// How an engine wants its audio sliced.
enum class ChunkMode {
  // Pack spans together up to the budget. Fewer, larger windows: fewer decoder invocations, and
  // fine for an engine that returns its own timestamps within a window.
  kPack,
  // One VAD span per chunk. For an engine that returns ONE untimestamped result per window, the
  // window IS the utterance — so packing would hand a single speaker label to everything said in
  // 30 seconds. Costs more invocations and buys turn-shaped utterances.
  kPerSpan,
};

// Combine VAD spans into decode windows.
//
// KNOWN DEFECT, PINNED DELIBERATELY (fixed in a later commit, with its own test diff): in kPack
// mode a single span longer than `max_chunk_ms` becomes one chunk of its FULL length, because the
// budget is only consulted when deciding whether to append another span. whisper survives this by
// re-windowing internally; an engine with a fixed token budget silently truncates instead.
std::vector<Chunk> makeChunks(const std::vector<Segment>& segs, int64_t max_chunk_ms,
                              ChunkMode mode = ChunkMode::kPack);

}  // namespace audionotes
```

- [ ] **Step 2: Write `cpp/asr/asr_chunker.cpp` — logic copied verbatim**

```cpp
#include "asr/asr_chunker.h"

namespace audionotes {

std::vector<Chunk> makeChunks(const std::vector<Segment>& segs, int64_t max_chunk_ms,
                              ChunkMode mode) {
  std::vector<Chunk> chunks;
  if (mode == ChunkMode::kPerSpan) {
    for (const auto& s : segs) chunks.push_back(Chunk{s.start_ms, s.end_ms});
    return chunks;
  }
  // Verbatim from whisper_asr.cpp:48-58. Do not "tidy" this — it is under characterization until
  // the commit that changes it on purpose.
  for (const auto& s : segs) {
    if (chunks.empty() || s.end_ms - chunks.back().start_ms > max_chunk_ms) {
      chunks.push_back(Chunk{s.start_ms, s.end_ms});
    } else {
      chunks.back().end_ms = s.end_ms;
    }
  }
  return chunks;
}

}  // namespace audionotes
```

- [ ] **Step 3: Write `cpp/tests/test_asr_chunker.cpp`**

```cpp
// Pins chunk boundaries exactly as they shipped, so the commit that fixes the over-long-span
// defect has to say so by editing an assertion rather than by quietly producing different audio.
#include "asr/asr_chunker.h"

#include <cstdio>

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
using audionotes::ChunkMode;
using audionotes::makeChunks;
using audionotes::Segment;

static void expectChunks(const std::vector<Chunk>& got,
                         const std::vector<Chunk>& want, const char* what) {
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
  const int64_t kBudget = 30000;

  expectChunks(makeChunks({}, kBudget), {}, "empty input");

  expectChunks(makeChunks({{0, 5000}}, kBudget), {{0, 5000}}, "single span");

  // Two spans inside the budget merge, and the chunk spans the GAP between them too.
  expectChunks(makeChunks({{0, 5000}, {6000, 10000}}, kBudget), {{0, 10000}}, "packed");

  // The budget is measured from the chunk's START, not from accumulated speech.
  expectChunks(makeChunks({{0, 5000}, {40000, 45000}}, kBudget),
               {{0, 5000}, {40000, 45000}}, "second span past the budget starts a new chunk");

  // Boundary: ending exactly AT the budget still packs (the test is >, not >=).
  expectChunks(makeChunks({{0, 5000}, {25000, 30000}}, kBudget), {{0, 30000}}, "exactly at budget");
  expectChunks(makeChunks({{0, 5000}, {25000, 30001}}, kBudget),
               {{0, 5000}, {25000, 30001}}, "one ms past the budget");

  // THE DEFECT, pinned. A 120 s uninterrupted span becomes ONE 120 s chunk — four times the
  // budget. whisper hides this by re-windowing internally; a token-budgeted engine truncates.
  // When this assertion is changed, the commit doing it is changing decoded audio on purpose.
  expectChunks(makeChunks({{0, 120000}}, kBudget), {{0, 120000}},
               "DEFECT: over-long span is not split");

  // kPerSpan never merges, which is what keeps utterances turn-shaped for an engine that
  // returns one untimestamped result per window.
  expectChunks(makeChunks({{0, 5000}, {6000, 10000}}, kBudget, ChunkMode::kPerSpan),
               {{0, 5000}, {6000, 10000}}, "per-span does not pack");

  if (failures == 0) std::printf("test_asr_chunker OK\n");
  return failures == 0 ? 0 : 1;
}
```

- [ ] **Step 4: Wire it into the build**

In `cpp/cli/CMakeLists.txt`, add `${CORE}/asr/asr_chunker.cpp` to `audionotes_cli`,
`test_pipeline_align` and `test_cancel` (each already lists `${CORE}/asr/whisper_asr.cpp` — put it
on the line directly after, in all three). Then register the new test next to `test_utf8`:

```cmake
audionotes_add_test(test_asr_chunker
  ${CORE}/tests/test_asr_chunker.cpp
  ${CORE}/asr/asr_chunker.cpp)
```

In `cpp/CMakeLists.txt`, add `asr/asr_chunker.cpp` to the `add_library(audionotes SHARED ...)`
list, directly after `asr/whisper_asr.cpp`.

- [ ] **Step 5: Point whisper at the shared chunker**

In `cpp/asr/whisper_asr.cpp`: delete the `makeChunks` definition (lines 47-59, the function and
its preceding comment — leave `readWindow` and the `kChunkMs` constant alone for now), add
`#include "asr/asr_chunker.h"` next to the existing includes, and change line 102 from
`const auto chunks = makeChunks(segments);` to:

```cpp
  const auto chunks = makeChunks(segments, kChunkMs);
```

The loop body uses `ch.first`/`ch.second`; `Chunk` uses named fields, so update the three uses
inside the loop to `ch.start_ms` and `ch.end_ms`.

- [ ] **Step 6: Build, test, and prove nothing changed**

```bash
cmake -S cpp/cli -B cpp/cli/build -G Ninja && cmake --build cpp/cli/build
ctest --test-dir cpp/cli/build --output-on-failure
python3 eval/characterize.py
```

Expected: 7/7 tests pass (the six plus `test_asr_chunker`), and **two `OK` lines** from
characterize with zero diffs. A diff here means the extraction was not verbatim — fix it, do not
re-record the baseline.

- [ ] **Step 7: Commit**

```bash
git add -A cpp/
git commit -m "refactor(asr): lift the chunker out of whisper, behaviour unchanged

Two engines need it, and their WER numbers are only comparable if they see
identical boundaries — a gap that was really a chunking artefact would be worse
than no measurement.

The over-long-span defect is carried across untouched and pinned as an
assertion: a single VAD span longer than the budget still becomes one chunk of
its full length. whisper hides it by re-windowing internally. Fixing it here
would have changed decoded audio inside a commit claiming to change nothing, so
it gets its own.

Verified with eval/characterize.py: both fixtures byte-identical."
```

---

## Task 3: Extract normalisation, unchanged

Today the UTF-8 scrub and dash strip live *inside whisper's decode loop* (`whisper_asr.cpp:145-152`).
A second engine that forgets them reintroduces a `json::dump` SIGABRT and a `NewStringUTF` VM
abort. Cleaning model output is the layer's job.

**Files:**
- Create: `cpp/asr/asr_postprocess.h`, `cpp/asr/asr_postprocess.cpp`
- Create: `cpp/tests/test_asr_postprocess.cpp`
- Modify: `cpp/asr/whisper_asr.cpp:145-152`
- Modify: `cpp/cli/CMakeLists.txt`, `cpp/CMakeLists.txt`

- [ ] **Step 1: Write `cpp/asr/asr_postprocess.h`**

```cpp
// Everything that must happen to model output before anything else is allowed to see it.
//
// This was inside whisper's decode loop, which made it whisper's private habit rather than a
// property of the layer. Both hazards it guards are load-bearing: an invalid UTF-8 byte makes
// nlohmann's dump() throw (uncaught, that is a SIGABRT after a whole meeting has processed) and
// ART's NewStringUTF abort the VM. An engine author who has not read that history must not be
// able to reintroduce it by writing a new engine.
#pragma once
#include <string>

namespace audionotes {

// One raw model segment, made safe and presentable. Returns "" when nothing survives, which the
// caller drops rather than emitting an empty utterance.
std::string normalizeSegmentText(const std::string& raw);

}  // namespace audionotes
```

- [ ] **Step 2: Write `cpp/asr/asr_postprocess.cpp` — same three operations, same order**

```cpp
#include "asr/asr_postprocess.h"

#include "util/utf8.h"

namespace audionotes {

std::string normalizeSegmentText(const std::string& raw) {
  // Order matters and is preserved from whisper_asr.cpp: scrub first, because the dash strip and
  // the space trim both index into the string and must not be looking at a broken sequence.
  std::string s = sanitizeUtf8(raw);
  if (!s.empty() && s.front() == ' ') s.erase(0, 1);
  return stripDialogueDash(s);
}

}  // namespace audionotes
```

- [ ] **Step 3: Write `cpp/tests/test_asr_postprocess.cpp`**

```cpp
// The three operations every engine's output goes through, in the order they must happen in.
// test_utf8 already covers sanitizeUtf8 and stripDialogueDash individually; this pins the
// COMPOSITION, which is the part an engine author could get wrong.
#include "asr/asr_postprocess.h"

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

static void expect(const std::string& in, const std::string& want, const char* what) {
  const std::string got = audionotes::normalizeSegmentText(in);
  CHECK(got == want, "%s: got \"%s\", want \"%s\"", what, got.c_str(), want.c_str());
}

int main() {
  expect(" Okay, let's ship on Friday.", "Okay, let's ship on Friday.", "leading space trimmed");
  expect(" - Design and what control?", "Design and what control?", "space then dialogue dash");
  expect("- Okay.", "Okay.", "dash with no leading space");
  expect("-5 degrees below", "-5 degrees below", "not a speaker mark, left alone");
  expect("", "", "empty");
  expect("   ", "  ", "only the FIRST leading space is trimmed");

  // Devanagari survives intact — the product's target audio must not be damaged in transit.
  expect("\xE0\xA4\xA8\xE0\xA4\xAE\xE0\xA4\xB8\xE0\xA5\x8D\xE0\xA4\xA4\xE0\xA5\x87",
         "\xE0\xA4\xA8\xE0\xA4\xAE\xE0\xA4\xB8\xE0\xA5\x8D\xE0\xA4\xA4\xE0\xA5\x87", "devanagari");

  // The byte that actually crashed a run, in the shape an engine hands it over.
  expect(" index \xB8 here", "index  here", "lone continuation byte scrubbed");
  expect(" truncated \xE0\xA4", "truncated ", "truncated sequence at end");

  // Scrub must run BEFORE the dash strip: a broken byte between dash and space would otherwise
  // hide the speaker mark from the stripper.
  expect(" - \xE0\xA4 ok", "\xEF\xBB\xBF" "ok" + std::string(), "scrub precedes dash strip");

  if (failures == 0) std::printf("test_asr_postprocess OK\n");
  return failures == 0 ? 0 : 1;
}
```

**Note on the last case:** work out the true expected value by running it — do not trust the
literal above. Replace it with whatever `normalizeSegmentText` actually returns *once you have
confirmed by hand that the value is correct*, and write a comment saying why. The point of the
case is ordering; the exact bytes depend on `sanitizeUtf8`'s drop semantics.

- [ ] **Step 4: Wire into the build**

`cpp/cli/CMakeLists.txt`: add `${CORE}/asr/asr_postprocess.cpp` alongside `asr_chunker.cpp` in
`audionotes_cli`, `test_pipeline_align` and `test_cancel`, and register:

```cmake
audionotes_add_test(test_asr_postprocess
  ${CORE}/tests/test_asr_postprocess.cpp
  ${CORE}/asr/asr_postprocess.cpp
  ${CORE}/util/utf8.cpp)
```

`cpp/CMakeLists.txt`: add `asr/asr_postprocess.cpp` after `asr/asr_chunker.cpp`.

- [ ] **Step 5: Call it from whisper**

Replace `whisper_asr.cpp:145-152` (from `std::string s = sanitizeUtf8(...)` through
`s = stripDialogueDash(s);`, keeping the surrounding comments as a pointer to the new home) with:

```cpp
      // Every engine's output goes through the same door — see asr_postprocess.h for the two
      // crashes that door exists to stop, and why an engine must not do this itself.
      const std::string s = normalizeSegmentText(text ? text : "");
```

Add `#include "asr/asr_postprocess.h"`. Remove `#include "util/utf8.h"` if nothing else in the
file uses it — check with `grep -n "sanitizeUtf8\|stripDialogueDash\|validUtf8" cpp/asr/whisper_asr.cpp`.

- [ ] **Step 6: Build, test, prove nothing changed**

```bash
cmake -S cpp/cli -B cpp/cli/build -G Ninja && cmake --build cpp/cli/build
ctest --test-dir cpp/cli/build --output-on-failure
python3 eval/characterize.py
```

Expected: 8/8 tests pass, two `OK` lines, zero diffs.

- [ ] **Step 7: Commit**

```bash
git add -A cpp/
git commit -m "refactor(asr): one normalisation stage for every engine, behaviour unchanged

The UTF-8 scrub and the dialogue-dash strip lived inside whisper's decode loop,
which made them whisper's private habit rather than a property of the layer. Both
are load-bearing: an invalid byte makes nlohmann's dump() throw — uncaught, a
SIGABRT after a whole meeting has processed — and ART's NewStringUTF abort the
VM. Writing a second engine was the moment that habit became reintroducible.

Same three operations in the same order. Verified byte-identical on both
characterization fixtures."
```

---

## Task 4: The `AsrEngine` interface

**Files:**
- Create: `cpp/asr/asr_engine.h`
- Modify: `cpp/asr/whisper_asr.h`, `cpp/asr/whisper_asr.cpp`
- Modify: `cpp/pipeline/pipeline.h:11`, `cpp/pipeline/pipeline.cpp:117`
- Modify: `cpp/jni/audionotes_jni.cpp:10,106`

- [ ] **Step 1: Write `cpp/asr/asr_engine.h`**

```cpp
// The shape every ASR engine presents to the rest of the core.
//
// Utterance lives here rather than in whisper's header because two engines now return it, and a
// type owned by one implementation is a type the next implementation has to include a competitor
// to use.
#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "asr/asr_chunker.h"  // ChunkMode
#include "vad/silero_vad.h"   // Segment

namespace audionotes {

struct Utterance {
  int64_t start_ms;
  int64_t end_ms;
  std::string text;
};

// progress(done_chunks, total_chunks)
using AsrProgressFn = std::function<void(int, int)>;

// Polled before each chunk; true = stop and return what has been transcribed so far. ASR is by
// far the longest stage, so a between-stages-only check would leave a cancel unanswered for
// minutes.
using AsrCancelFn = std::function<bool()>;

// What a run produced AND what happened during it. The second half is not bookkeeping: a
// transcribe() that returned a bare vector could not distinguish "the room was silent" from
// "every chunk failed to decode", and the pipeline reported both as "no speech detected".
struct AsrRun {
  std::vector<Utterance> utterances;
  int chunks_total = 0;
  int chunks_failed = 0;
  bool cancelled = false;

  // Provenance. Recorded so a user reporting a garbled meeting can be answered with what actually
  // ran, rather than with what we assume runs.
  std::string engine;            // "whisper" | "qwen3"
  std::string model_path;
  std::string language;          // what was requested
  std::string detected_language; // what the engine reported, where it can; "" otherwise

  // The state that must never again be reported as silence.
  bool allChunksFailed() const { return chunks_total > 0 && chunks_failed == chunks_total; }
};

class AsrEngine {
 public:
  virtual ~AsrEngine() = default;

  // False when the engine is not compiled in or its weights failed to load. Construction always
  // succeeds — sherpa segfaults rather than returning an error, so loading is guarded, not caught.
  virtual bool ok() const = 0;

  virtual const char* name() const = 0;
  virtual int64_t maxChunkMs() const = 0;
  virtual ChunkMode chunkMode() const = 0;
  virtual bool supports(const std::string& language) const = 0;

  // pcm_path: 16 kHz mono PCM16. segments: VAD speech spans (ms).
  // `threads` <= 0 selects the big.LITTLE-aware default (see util/cpu_topology.h).
  virtual AsrRun transcribe(const std::string& pcm_path,
                            const std::vector<Segment>& segments,
                            int sample_rate,
                            int threads = 0,
                            const AsrProgressFn& progress = nullptr,
                            const AsrCancelFn& cancel = nullptr) = 0;
};

// A path PER ENGINE, not one shared model_path: the factory routes by language, so it must be
// able to reach either engine's weights without the caller having already guessed which engine
// its language was going to select.
struct AsrConfig {
  std::string engine;           // "" = choose by policy; "whisper"/"qwen3" forces one
  std::string language = "en";
  std::string whisper_model;    // a file
  std::string qwen3_model_dir;  // a directory; "" when not installed
};

// The one place a language becomes a class. Never returns null: when nothing usable is available
// it returns an engine whose ok() is false, carrying the reason, so callers have one failure
// path rather than two.
std::unique_ptr<AsrEngine> makeAsrEngine(const AsrConfig& cfg);

}  // namespace audionotes
```

- [ ] **Step 2: Make `WhisperAsr` implement it**

In `cpp/asr/whisper_asr.h`: delete `struct Utterance`, `AsrProgressFn` and `AsrCancelFn` (now in
`asr_engine.h`), replace `#include "vad/silero_vad.h"` with `#include "asr/asr_engine.h"`, and
change the class to:

```cpp
class WhisperAsr : public AsrEngine {
 public:
  explicit WhisperAsr(const std::string& model_path, const std::string& language = "en");
  ~WhisperAsr() override;

  bool ok() const override;
  const char* name() const override { return "whisper"; }
  // 30 s is whisper's own internal window; matching it means a chunk is one forward pass.
  int64_t maxChunkMs() const override { return 30000; }
  // whisper returns its own timestamped segments within a window, so packing costs no
  // utterance granularity.
  ChunkMode chunkMode() const override { return ChunkMode::kPack; }
  // whisper covers ~99 languages; whisper_lang_id() rejects anything it does not know.
  bool supports(const std::string& language) const override;

  AsrRun transcribe(const std::string& pcm_path,
                    const std::vector<Segment>& segments,
                    int sample_rate,
                    int threads = 0,
                    const AsrProgressFn& progress = nullptr,
                    const AsrCancelFn& cancel = nullptr) override;

 private:
  struct Impl;
  Impl* impl_;
};
```

In `cpp/asr/whisper_asr.cpp`, change `transcribe`'s return type to `AsrRun`, and:

- open with `AsrRun run; run.engine = "whisper"; run.model_path = impl_->model_path; run.language = impl_->language;`
  (add a `model_path` member to `Impl`, set in its constructor)
- `run.chunks_total = total;` after chunking
- replace `utts.push_back(...)` with `run.utterances.push_back(...)`
- on the `whisper_full(...) != 0` branch, `++run.chunks_failed;` before `continue`
- on the cancel branch, `run.cancelled = true;`
- `return run;`
- add `supports`:

```cpp
bool WhisperAsr::supports(const std::string& language) const {
#ifdef HAVE_WHISPER
  // "auto" is not a language, it is the absence of a choice — still accepted, still not default.
  if (language == "auto") return true;
  return whisper_lang_id(language.c_str()) >= 0;
#else
  (void)language;
  return false;
#endif
}
```

Keep `kChunkMs` but make the call `makeChunks(segments, maxChunkMs(), chunkMode())`.

- [ ] **Step 3: Update the three call sites**

- `cpp/pipeline/pipeline.h:11`: `#include "asr/whisper_asr.h"` → `#include "asr/asr_engine.h"`
  (the comment `// Utterance {start_ms,end_ms,text}` stays true).
- `cpp/pipeline/pipeline.cpp:117`: keep `WhisperAsr asr(cfg_.asr_model, cfg_.language);` for now
  and adapt to the new return type — `auto run = asr.transcribe(...); ` then use `run.utterances`
  where the old vector was used. Task 5 replaces the construction with the factory.
- `cpp/jni/audionotes_jni.cpp:10,106`: same — include `asr/asr_engine.h` as well, and take
  `.utterances` from the returned run.

- [ ] **Step 4: Build, test, prove nothing changed**

```bash
cmake -S cpp/cli -B cpp/cli/build -G Ninja && cmake --build cpp/cli/build
ctest --test-dir cpp/cli/build --output-on-failure
python3 eval/characterize.py
```

Expected: 8/8 pass, two `OK`, zero diffs.

- [ ] **Step 5: Commit**

```bash
git add -A cpp/
git commit -m "refactor(asr): an AsrEngine interface, and a run that reports what happened

Utterance moves out of whisper's header: two engines return it now, and a type
owned by one implementation is a type the next has to include a competitor to use.

transcribe() returns AsrRun rather than a bare vector. The bare vector could not
distinguish a silent room from every chunk failing to decode, and the pipeline
reported both as 'no speech detected' — the two most different outcomes it has.
AsrRun also carries provenance, so a user reporting a garbled meeting can be
answered with what ran rather than what we assume runs.

Whisper's output verified byte-identical on both fixtures."
```

---

## Task 5: The factory and its policy table

**Files:**
- Create: `cpp/asr/asr_factory.cpp`
- Create: `cpp/tests/test_asr_factory.cpp`
- Modify: `cpp/pipeline/pipeline.h`, `cpp/pipeline/pipeline.cpp:117`
- Modify: `cpp/cli/main.cpp`
- Modify: `cpp/cli/CMakeLists.txt`, `cpp/CMakeLists.txt`

- [ ] **Step 1: Write `cpp/asr/asr_factory.cpp`**

```cpp
#include "asr/asr_engine.h"

#include "asr/qwen3_asr.h"
#include "asr/whisper_asr.h"

#include <cstdio>

namespace audionotes {
namespace {

// An engine that failed to become available, so callers have ONE failure path instead of a null
// check plus an ok() check.
class UnavailableAsr : public AsrEngine {
 public:
  explicit UnavailableAsr(std::string why) : why_(std::move(why)) {}
  bool ok() const override { return false; }
  const char* name() const override { return "none"; }
  int64_t maxChunkMs() const override { return 30000; }
  ChunkMode chunkMode() const override { return ChunkMode::kPack; }
  bool supports(const std::string&) const override { return false; }
  AsrRun transcribe(const std::string&, const std::vector<Segment>&, int, int,
                    const AsrProgressFn&, const AsrCancelFn&) override {
    AsrRun r;
    r.engine = "none";
    r.detected_language = why_;
    return r;
  }

 private:
  std::string why_;
};

// Which engine wins for a language, when both are installed.
//
// This is a table and not a heuristic on purpose: a routing decision that cannot be read off the
// page is one nobody can audit when a meeting comes back wrong. Rows are added only when
// MEASURED — CJK is a plausible Qwen win and is deliberately absent until somebody scores it.
//
// hi: Qwen3-ASR read the 2026-08-19 recording at 1,211 words and 87.6% Devanagari against
// whisper-base's 891 and 8.8%, with Urdu-script junk down from 21.1% to 1.0%.
bool prefersQwen(const std::string& language) {
  return language == "hi";
}

}  // namespace

std::unique_ptr<AsrEngine> makeAsrEngine(const AsrConfig& cfg) {
  const bool force_whisper = cfg.engine == "whisper";
  const bool force_qwen = cfg.engine == "qwen3";
  if (!cfg.engine.empty() && !force_whisper && !force_qwen) {
    return std::unique_ptr<AsrEngine>(new UnavailableAsr("unknown engine: " + cfg.engine));
  }

  const bool want_qwen = force_qwen || (!force_whisper && prefersQwen(cfg.language));

  if (want_qwen && !cfg.qwen3_model_dir.empty()) {
    auto q = std::unique_ptr<Qwen3Asr>(new Qwen3Asr(cfg.qwen3_model_dir, cfg.language));
    if (q->ok()) return q;
    // Fall through rather than fail: a Hindi meeting transcribed by whisper because Qwen was not
    // downloaded is a worse transcript but a real one, and AsrRun.engine records which ran.
    std::fprintf(stderr, "qwen3 unavailable at %s, falling back\n", cfg.qwen3_model_dir.c_str());
  }
  if (force_qwen) {
    return std::unique_ptr<AsrEngine>(new UnavailableAsr("qwen3 requested but unavailable"));
  }

  if (cfg.whisper_model.empty()) {
    return std::unique_ptr<AsrEngine>(new UnavailableAsr("no whisper model configured"));
  }
  return std::unique_ptr<AsrEngine>(new WhisperAsr(cfg.whisper_model, cfg.language));
}

}  // namespace audionotes
```

- [ ] **Step 2: Write `cpp/tests/test_asr_factory.cpp`**

Routing is testable without weights: `ok()` will be false everywhere (no real models), but
`name()` tells you which class was selected, which is the decision under test.

```cpp
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

  // English is whisper's: it is the international floor, 60 MB, and free-tier.
  { AsrConfig c = both; c.language = "en"; CHECK(chose(c) == "whisper", "en -> %s", chose(c).c_str()); }
  { AsrConfig c = both; c.language = "de"; CHECK(chose(c) == "whisper", "de -> %s", chose(c).c_str()); }
  { AsrConfig c = both; c.language = "fr"; CHECK(chose(c) == "whisper", "fr -> %s", chose(c).c_str()); }

  // Hindi routes to Qwen — but the directory above does not exist, so it must FALL BACK rather
  // than fail. A worse transcript is a product; no transcript is not.
  { AsrConfig c = both; c.language = "hi"; CHECK(chose(c) == "whisper", "hi with no qwen installed -> %s", chose(c).c_str()); }

  // An explicit override beats the table, in both directions.
  { AsrConfig c = both; c.language = "hi"; c.engine = "whisper"; CHECK(chose(c) == "whisper", "forced whisper"); }
  { AsrConfig c = both; c.language = "en"; c.engine = "qwen3"; CHECK(chose(c) == "none", "forced qwen with none installed must not silently give whisper"); }

  // No model at all is an engine whose ok() is false, never a null pointer.
  { AsrConfig c; c.language = "en"; auto e = makeAsrEngine(c); CHECK(e != nullptr, "never null"); CHECK(!e->ok(), "no model -> not ok"); }

  { AsrConfig c = both; c.engine = "nonsense"; CHECK(chose(c) == "none", "unknown engine name"); }

  if (failures == 0) std::printf("test_asr_factory OK\n");
  return failures == 0 ? 0 : 1;
}
```

- [ ] **Step 3: Route the pipeline and the CLI through the factory**

`cpp/pipeline/pipeline.h`: add `std::string qwen3_model_dir;` and `std::string asr_engine;` to
`PipelineConfig`, next to `asr_model`.

`cpp/pipeline/pipeline.cpp:117`, replace the direct construction:

```cpp
    AsrConfig acfg;
    acfg.engine = cfg_.asr_engine;
    acfg.language = cfg_.language;
    acfg.whisper_model = cfg_.asr_model;
    acfg.qwen3_model_dir = cfg_.qwen3_model_dir;
    auto asr = makeAsrEngine(acfg);
```

`cpp/cli/main.cpp`: add two flags next to `--language`, and extend the usage string:

```cpp
    else if (std::strcmp(argv[i], "--asr-engine") == 0 && i + 1 < argc) asr_engine = argv[++i];
    else if (std::strcmp(argv[i], "--qwen3-model") == 0 && i + 1 < argc) qwen3_model = argv[++i];
```

with `std::string asr_engine, qwen3_model;` declared beside `language`, and
`cfg.asr_engine = asr_engine; cfg.qwen3_model_dir = qwen3_model;` beside `cfg.language = language;`.

- [ ] **Step 4: Wire into the build**

`cpp/cli/CMakeLists.txt`: add `${CORE}/asr/asr_factory.cpp` and `${CORE}/asr/qwen3_asr.cpp` to
`audionotes_cli`, `test_pipeline_align` and `test_cancel`, and register:

```cmake
audionotes_add_test(test_asr_factory
  ${CORE}/tests/test_asr_factory.cpp
  ${CORE}/asr/asr_factory.cpp
  ${CORE}/asr/asr_chunker.cpp
  ${CORE}/asr/asr_postprocess.cpp
  ${CORE}/asr/whisper_asr.cpp
  ${CORE}/asr/qwen3_asr.cpp
  ${CORE}/util/utf8.cpp
  ${CORE}/util/ort_init.cpp
  ${CORE}/vad/silero_vad.cpp)
target_include_directories(test_asr_factory PRIVATE
  ${TP}/onnxruntime/include ${TP}/whisper.cpp/include ${TP}/whisper.cpp/ggml/include)
target_compile_definitions(test_asr_factory PRIVATE HAVE_WHISPER)
target_link_libraries(test_asr_factory PRIVATE whisper ${CMAKE_DL_LIBS})
if(ORT_LIB)
  target_compile_definitions(test_asr_factory PRIVATE HAVE_SHERPA=1)
  target_include_directories(test_asr_factory PRIVATE ${TP}/sherpa-onnx)
  target_link_libraries(test_asr_factory PRIVATE sherpa-onnx-c-api)
  set_target_properties(test_asr_factory PROPERTIES BUILD_RPATH "${ORT_ROOT}/lib")
endif()
```

`cpp/CMakeLists.txt`: add `asr/asr_factory.cpp` and `asr/qwen3_asr.cpp` to the library sources.

**This task depends on Task 6's `qwen3_asr.h/.cpp` existing.** Create them as a stub first — the
header exactly as Task 6 defines it, and a `.cpp` whose constructor sets `ok_ = false` — then
land Task 6's real implementation on top. Building the factory against a stub is what lets its
routing tests run before the engine works.

- [ ] **Step 5: Build, test, prove nothing changed**

```bash
cmake -S cpp/cli -B cpp/cli/build -G Ninja && cmake --build cpp/cli/build
ctest --test-dir cpp/cli/build --output-on-failure
python3 eval/characterize.py
```

Expected: 9/9 pass, two `OK`, zero diffs.

- [ ] **Step 6: Commit**

```bash
git add -A cpp/
git commit -m "feat(asr): route by language through one readable policy table

A table and not a heuristic: a routing decision that cannot be read off the page
is one nobody can audit when a meeting comes back wrong. Rows are added only when
measured — CJK is a plausible Qwen win and is deliberately absent until scored.

Fallback is explicit and recorded. A Hindi meeting transcribed by whisper because
Qwen was not downloaded is a worse transcript but a real one, and AsrRun.engine
says which ran. A forced engine that is unavailable does NOT silently degrade,
because a benchmark that quietly measured the other engine would be worse than a
failed one.

Whisper's output verified byte-identical on both fixtures."
```

---

## Task 6: The Qwen3-ASR engine

**Files:**
- Create: `cpp/asr/qwen3_asr.h`, `cpp/asr/qwen3_asr.cpp` (replacing the Task 5 stub)

The four artifacts resolve by convention from one directory: `conv_frontend.onnx`,
`encoder.onnx`, `decoder.onnx`, `tokenizer/`.

- [ ] **Step 1: Write `cpp/asr/qwen3_asr.h`**

```cpp
// Qwen3-ASR over sherpa-onnx's offline recognizer.
//
// Exists because whisper cannot hear Hindi: on the 2026-08-19 recording whisper-base produced 891
// words at 8.8% Devanagari with 21.1% Urdu-script junk, and this produced 1,211 words at 87.6%
// with 1.0%.
//
// TWO THINGS THAT SHAPE THIS CLASS:
//
// 1. It returns ONE UNTIMESTAMPED result per window. whisper returns several timestamped segments
//    per window; this does not fill result.timestamps at all. Since speakers are assigned per
//    utterance, packing 30 s of audio into one window would hand everything said in it a single
//    speaker label. Hence ChunkMode::kPerSpan.
// 2. Its decoder has a fixed token budget (max_total_len, 512 by default) and SILENTLY TRUNCATES
//    audio that exceeds it — roughly 38 s. maxChunkMs() stays well inside that.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

#include "asr/asr_engine.h"

namespace audionotes {

class Qwen3Asr : public AsrEngine {
 public:
  // model_dir contains conv_frontend.onnx, encoder.onnx, decoder.onnx and tokenizer/.
  explicit Qwen3Asr(const std::string& model_dir, const std::string& language = "en");
  ~Qwen3Asr() override;

  bool ok() const override;
  const char* name() const override { return "qwen3"; }

  // Well inside the ~38 s the 512-token budget allows, because the budget is consumed by the
  // prompt and hotwords too and running near a silent-truncation cliff is not worth the speed.
  int64_t maxChunkMs() const override { return 25000; }

  // One result per window and no timestamps, so the window must be the turn. See the header note.
  ChunkMode chunkMode() const override { return ChunkMode::kPerSpan; }

  bool supports(const std::string& language) const override;

  AsrRun transcribe(const std::string& pcm_path,
                    const std::vector<Segment>& segments,
                    int sample_rate,
                    int threads = 0,
                    const AsrProgressFn& progress = nullptr,
                    const AsrCancelFn& cancel = nullptr) override;

 private:
  struct Impl;
  Impl* impl_;
};

}  // namespace audionotes
```

- [ ] **Step 2: Write `cpp/asr/qwen3_asr.cpp`**

Follow `cpp/diar/diarizer.cpp` closely — it is the existing sherpa-through-the-C-API precedent in
this codebase, including the `readable()` guard and `ensureOrtApi()`. The decode loop per chunk:

```cpp
    const SherpaOnnxOfflineStream* stream = SherpaOnnxCreateOfflineStream(impl_->recognizer);
    // The language hint. Unhinted, this model returned pure Mandarin for one chunk in eight of a
    // Hindi recording — it is a Chinese-team model and zh is its home language. This is the same
    // value whisper is pinned with, so both engines are told the same thing.
    if (!impl_->language.empty() && impl_->language != "auto") {
      SherpaOnnxOfflineStreamSetOption(stream, "language", impl_->language.c_str());
    }
    SherpaOnnxAcceptWaveformOffline(stream, sample_rate, samples.data(),
                                    static_cast<int32_t>(samples.size()));
    SherpaOnnxDecodeOfflineStream(impl_->recognizer, stream);
    const SherpaOnnxOfflineRecognizerResult* res = SherpaOnnxGetOfflineStreamResult(stream);

    if (res && res->text) {
      if (res->lang && *res->lang && run.detected_language.empty()) {
        run.detected_language = res->lang;
      }
      // Same door as every other engine — see asr_postprocess.h.
      const std::string s = normalizeSegmentText(res->text);
      // No timestamps from this model, so the window IS the utterance.
      if (!s.empty()) run.utterances.push_back(Utterance{ch.start_ms, ch.end_ms, s});
    } else {
      ++run.chunks_failed;
    }
    if (res) SherpaOnnxDestroyOfflineRecognizerResult(res);
    SherpaOnnxDestroyOfflineStream(stream);
```

Construction, in `Impl`, guarded exactly as the diarizer guards its models:

```cpp
    // sherpa does not tolerate a path it cannot read: rather than returning null it dereferences
    // a null internal pointer and takes the process down with SIGSEGV. Check first.
    if (!readable(conv_frontend) || !readable(encoder) || !readable(decoder)) { ok = false; return; }
    ensureOrtApi();

    SherpaOnnxOfflineRecognizerConfig config;
    std::memset(&config, 0, sizeof(config));
    config.model_config.qwen3_asr.conv_frontend = conv_frontend.c_str();
    config.model_config.qwen3_asr.encoder = encoder.c_str();
    config.model_config.qwen3_asr.decoder = decoder.c_str();
    config.model_config.qwen3_asr.tokenizer = tokenizer.c_str();
    config.model_config.qwen3_asr.max_total_len = 512;
    config.model_config.qwen3_asr.max_new_tokens = 128;
    config.model_config.qwen3_asr.temperature = 1e-6f;  // effectively greedy: a transcript must
    config.model_config.qwen3_asr.top_p = 0.8f;         // be reproducible to be scoreable
    config.model_config.qwen3_asr.seed = 42;
    config.model_config.num_threads = threads;
    config.model_config.provider = "cpu";
    recognizer = SherpaOnnxCreateOfflineRecognizer(&config);
    ok = (recognizer != nullptr);
```

`supports` returns true for the languages Qwen is routed for; keep it honest and narrow:

```cpp
bool Qwen3Asr::supports(const std::string& language) const {
  // Deliberately not "everything Qwen claims". This reports what we route to it, and the table in
  // asr_factory.cpp only gains a row once somebody has scored it.
  return language == "en" || language == "hi" || language == "auto";
}
```

Everything else — `readWindow`, the chunk loop, progress, cancel between chunks — mirrors
`whisper_asr.cpp` exactly. Guard the whole file with `#ifdef HAVE_SHERPA` and make `ok()` false
otherwise, as the diarizer does.

- [ ] **Step 3: Build and confirm it compiles into every target**

```bash
cmake -S cpp/cli -B cpp/cli/build -G Ninja && cmake --build cpp/cli/build
ctest --test-dir cpp/cli/build --output-on-failure
```

Expected: 9/9 pass. `test_asr_factory`'s forced-qwen case still resolves to `none` because no
weights are present yet — that is correct, and it is what proves the fallback logic is real.

- [ ] **Step 4: Fetch the weights and run it for real**

Qwen3-ASR ONNX weights are published by the sherpa-onnx author. Download the 0.6B export, unpack
to `eval/models/qwen3-asr/` so that `conv_frontend.onnx`, `encoder.onnx`, `decoder.onnx` and
`tokenizer/` sit directly inside, then:

```bash
cpp/cli/build/audionotes_cli eval/models/ggml-base-q5_1.bin \
  eval/fixtures/real-neosym-2026-08-19/audio.wav \
  --vad eval/models/silero_vad.onnx \
  --asr-engine qwen3 --qwen3-model eval/models/qwen3-asr \
  --language hi --json /tmp/qwen-hi.json
python3 -c "
import json; d=json.load(open('/tmp/qwen-hi.json'))
t=d['transcript']; print(len(t),'utterances', sum(len(u['text'].split()) for u in t),'words')
print(t[0]['text'][:200])"
```

Expected: a non-empty transcript in Devanagari. **If it is empty**, check stderr for the
`max_total_len` warning — that is the silent-truncation path, and it means `maxChunkMs()` is still
too large for this export's actual budget.

- [ ] **Step 5: Commit**

```bash
git add -A cpp/
git commit -m "feat(asr): a Qwen3-ASR engine, for the language whisper cannot hear

On the 2026-08-19 recording whisper-base produced 891 words at 8.8% Devanagari
with 21.1% Urdu-script junk; this produced 1,211 at 87.6% with 1.0%.

Chunks per VAD span rather than packing to a budget, which looks wasteful and is
not: this model returns one UNTIMESTAMPED result per window, and speakers are
assigned per utterance, so a packed 30s window would hand everything said in it a
single speaker label. The window has to be the turn.

Carries the language hint, which is the real fix for the Mandarin that came back
for one chunk in eight of a Hindi recording — it is a Chinese-team model and zh is
its home language. Same value whisper is pinned with, so both are told the same
thing. Temperature is effectively zero because a transcript that cannot be
reproduced cannot be scored."
```

---

## Task 7: Fix the chunker defect

The first commit that changes decoded audio on purpose.

**Files:**
- Modify: `cpp/asr/asr_chunker.cpp`, `cpp/asr/asr_chunker.h`
- Modify: `cpp/tests/test_asr_chunker.cpp`
- Modify: `eval/baseline/*.json` (re-recorded, deliberately)

- [ ] **Step 1: Change the pinned assertion first**

In `cpp/tests/test_asr_chunker.cpp`, replace the `DEFECT` case with the intended behaviour, and
add the overlap cases:

```cpp
  // A span longer than the budget is now SPLIT rather than passed through whole. 120 s at a 30 s
  // budget is four windows. This assertion is the record of that decision.
  expectChunks(makeChunks({{0, 120000}}, kBudget),
               {{0, 30000}, {30000, 60000}, {60000, 90000}, {90000, 120000}},
               "over-long span is split at the budget");

  // A split that lands mid-word would lose it, so splits overlap and the merge drops the
  // duplicate. Exact boundaries depend on kOverlapMs — assert against the constant, not literals.
  expectChunks(makeChunks({{0, 45000}}, kBudget),
               {{0, 30000}, {30000, 45000}}, "split leaves no gap");
```

- [ ] **Step 2: Watch it fail**

```bash
cmake --build cpp/cli/build && ctest --test-dir cpp/cli/build -R test_asr_chunker --output-on-failure
```

Expected: FAIL — `got 1 chunks, want 4`.

- [ ] **Step 3: Implement the split**

In `makeChunks`'s `kPack` branch, after the existing append/new-chunk decision, split any chunk
longer than `max_chunk_ms` into `ceil(len / max_chunk_ms)` equal windows so no window exceeds the
budget and no audio is dropped between them. Apply the same split in the `kPerSpan` branch — a
single VAD span can exceed the budget there too.

- [ ] **Step 4: Verify and re-record the baseline deliberately**

```bash
cmake --build cpp/cli/build && ctest --test-dir cpp/cli/build --output-on-failure
python3 eval/characterize.py
```

Expected: 9/9 tests pass, and characterize **DIFFs** — which is correct here and the only task
where it is. Inspect the diff and confirm it is confined to fixtures containing spans longer than
30 s. Then re-record:

```bash
python3 eval/characterize.py --record && python3 eval/characterize.py
```

- [ ] **Step 5: Commit**

```bash
git add -A cpp/ eval/baseline/
git commit -m "fix(asr): split VAD spans longer than the decode budget

makeChunks only consulted the budget when deciding whether to APPEND a span, so
a single span longer than it became one chunk of its full length — a four-minute
monologue was a four-minute window. whisper hid this by re-windowing internally,
which is why it survived this long; Qwen3-ASR would have silently dropped
everything past ~38s of it, with only a debug-level warning.

Splits overlap so a word landing on a cut is not halved. That is the cause-level
fix for the chunk-boundary damage the UTF-8 scrub has been compensating for.

This is the one commit in this series that changes decoded audio on purpose, so
the characterization baseline is re-recorded here and only here."
```

---

## Task 8: Score it

**Files:**
- Modify: `eval/run.py`

- [ ] **Step 1: Add the engine flags**

`eval/run.py` already has an uncommitted `--asr` flag selecting whisper weights. Extend
`run_cli()` and `main()` with `--asr-engine` and `--qwen3-model`, passed through to the CLI, and
record both in the results dict beside the existing `"asr"` key.

- [ ] **Step 2: Add the script histogram**

The measurement that makes the Chinese leak a number rather than something noticed by reading:

```python
def script_histogram(text):
    """Which writing systems a transcript actually came back in.

    The 2026-08-19 recording returned FIVE scripts including Korean and Chinese, and nobody knew
    until they read it. A per-fixture percentage turns that into a number a run can be judged on:
    a Hindi meeting that is 8% CJK is a failure however good its WER looks.
    """
    counts = {"latin": 0, "devanagari": 0, "arabic": 0, "cjk": 0, "other": 0}
    for ch in text:
        cp = ord(ch)
        if not ch.strip() or not ch.isalnum():
            continue
        if cp < 0x0250:                     counts["latin"] += 1
        elif 0x0900 <= cp <= 0x097F:        counts["devanagari"] += 1
        elif 0x0600 <= cp <= 0x06FF:        counts["arabic"] += 1
        elif 0x4E00 <= cp <= 0x9FFF or 0x3040 <= cp <= 0x30FF or 0xAC00 <= cp <= 0xD7AF:
            counts["cjk"] += 1
        else:                               counts["other"] += 1
    total = sum(counts.values()) or 1
    return {k: round(100.0 * v / total, 1) for k, v in counts.items()}
```

Call it on the joined transcript text per fixture and add the result to each fixture's scored
record as `"scripts"`.

- [ ] **Step 3: Run all three configurations**

```bash
python3 -m eval.run --cli cpp/cli/build/audionotes_cli --models eval/models --only real-neosym-2026-08-19
python3 -m eval.run --cli cpp/cli/build/audionotes_cli --models eval/models --only real-neosym-2026-08-19 --asr ggml-small-q5_1.bin
python3 -m eval.run --cli cpp/cli/build/audionotes_cli --models eval/models --only real-neosym-2026-08-19 --asr-engine qwen3 --qwen3-model eval/models/qwen3-asr --language hi
```

Expected: three result sets, each carrying a `scripts` histogram. Compare the `cjk` percentage
with and without the language hint — that is the Chinese-leak measurement the design asked for.

- [ ] **Step 4: Commit**

```bash
git add -A eval/
git commit -m "test(eval): score any engine, and count what script it answered in

The 2026-08-19 recording came back in five scripts including Korean and Chinese
and nobody knew until they read it. A per-fixture script histogram makes that a
number: a Hindi meeting that is 8% CJK is a failure however good its WER looks.

This is also how the language hint gets judged rather than assumed. The design
deliberately shipped no CJK output filter, because a threshold guessed before the
evidence exists can silently delete real speech — this is the evidence."
```

---

## Task 9: Tell the minutes what language to come out in

Spec §8. `llm_prompts.cpp` contains no language instruction anywhere, so minutes come out in
whatever language the model drifts to. English in, English out is currently luck.

Kept to the C++ side by giving every prompt a defaulted parameter: existing JNI methods and
Kotlin's `Narrator` compile untouched, and the Android wiring becomes a follow-up rather than a
prerequisite.

**Files:**
- Modify: `cpp/minutes/llm_minutes.h:22-49` (eight signatures)
- Modify: `cpp/minutes/llm_prompts.cpp`
- Test: `cpp/tests/test_llm_minutes.cpp`

- [ ] **Step 1: Write the failing test**

Add to `cpp/tests/test_llm_minutes.cpp`:

```cpp
  // A meeting recognised in Hindi must not be summarised into English by accident, and one
  // recognised in English must not drift out of it. Prompts state the language; they used to
  // state nothing at all.
  {
    const std::string en = audionotes::narrativePrompt("Ravi will send the deck.", "en");
    CHECK(en.find("English") != std::string::npos, "en prompt names the language");

    const std::string hi = audionotes::narrativePrompt("Ravi will send the deck.", "hi");
    CHECK(hi.find("Hindi") != std::string::npos, "hi prompt names the language");
    CHECK(hi != en, "language must actually change the prompt");

    // The default keeps every existing caller behaving exactly as it does today.
    CHECK(audionotes::narrativePrompt("Ravi will send the deck.") == en, "default is en");
  }
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cmake --build cpp/cli/build && ctest --test-dir cpp/cli/build -R test_llm_minutes --output-on-failure
```

Expected: compile error — `narrativePrompt` takes one argument.

- [ ] **Step 3: Add the directive**

In `cpp/minutes/llm_prompts.cpp`, add near the top of the anonymous namespace:

```cpp
// The language the WRITTEN OUTPUT must be in, which is not necessarily the language the meeting
// was recognised in — that separation is the point. Recognition stays faithful to what was
// spoken; this decides what the reader is handed. Unknown codes fall back to English rather than
// naming a language the model may not write well.
std::string languageDirective(const std::string& code) {
  if (code == "hi") return "Write in Hindi.";
  if (code == "es") return "Write in Spanish.";
  if (code == "fr") return "Write in French.";
  if (code == "de") return "Write in German.";
  return "Write in English.";
}
```

Give all eight prompt functions in `cpp/minutes/llm_minutes.h:22-49` a
`const std::string& language = "en"` final parameter, and have each definition insert
`languageDirective(language)` as its own line in the instruction block.

- [ ] **Step 4: Verify green**

```bash
cmake --build cpp/cli/build && ctest --test-dir cpp/cli/build --output-on-failure
```

Expected: 9/9 pass. No characterization run needed — this touches no ASR path.

- [ ] **Step 5: Commit**

```bash
git add -A cpp/
git commit -m "feat(minutes): say what language to write in, instead of hoping

llm_prompts.cpp contained no language instruction at all, so minutes came out in
whatever language the model drifted to. English in, English out was luck.

Defaulted parameter, so every existing JNI method and Kotlin caller is unchanged.
The directive is deliberately about OUTPUT, not recognition: recognition stays
faithful to what was spoken, and this decides what the reader is handed. That
separation is what lets a Hindi meeting produce English minutes without ever
destroying the Hindi."
```

---

## Task 10: Offer every language the engine supports

Spec §7. `src/screens/SettingsScreen.tsx:111` hard-codes `auto / en / hi`. That is an India-only
list in a product launching in the US and Europe, and it is the one thing that would stop a German
or Spanish user being able to capture their own meetings at all.

**This task crosses into Kotlin and TypeScript**, unlike Tasks 1-9. It is here because it directly
implements the product requirement; land it separately if you want the core work reviewed alone.

**Files:**
- Modify: `cpp/jni/audionotes_jni.cpp`
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/NativeBridge.kt`
- Modify: `src/screens/SettingsScreen.tsx:111-115`

- [ ] **Step 1: Add the JNI method**

In `cpp/jni/audionotes_jni.cpp`, following the shape of the existing `nativeMinutes`, add a method
returning a JSON array of `{"code","label"}` built from whisper's own tables:

```cpp
  // The list is asked of the ENGINE rather than written down here, because a hand-maintained copy
  // drifts from what the model can actually do — and the failure that causes is a user who cannot
  // select the language they are about to speak.
  for (int id = 0; id <= whisper_lang_max_id(); ++id) {
    const char* code = whisper_lang_str(id);
    const char* label = whisper_lang_str_full(id);
    // ... append {"code": code, "label": label}
  }
```

Scrub each label through `sanitizeUtf8` before it crosses the JNI boundary — `NewStringUTF`
aborts the VM on a bad byte, and these strings come from a third-party table.

- [ ] **Step 2: Expose it on `NativeBridge`**

```kotlin
  /**
   * Every language the transcriber can be pinned to, asked of the engine rather than listed here.
   * Verbale ships in India, the US and Europe; a hard-coded shortlist is how somebody ends up
   * unable to select the language they are about to speak.
   */
  external fun nativeSupportedLanguages(): String
```

- [ ] **Step 3: Consume it in Settings**

Replace the hard-coded `LANGUAGE_CHOICES` with state loaded from the bridge, keeping the current
three as the fallback if the call fails, and keeping `en` selected by default. Pin `en` and `hi`
to the top of the list, then the rest alphabetically — a 99-item picker in raw engine order is
unusable, and the two at the top are the ones this product is measured on.

- [ ] **Step 4: Verify on the device**

```bash
cd android && ./gradlew assembleDebug && cd ..
npm run android
```

Open Settings and confirm the language picker lists far more than three entries, that `English` is
selected by default, and that choosing one persists across an app restart.

- [ ] **Step 5: Commit**

```bash
git add -A cpp/ android/ src/
git commit -m "feat(settings): offer every language the engine supports, not three

The picker hard-coded auto/en/hi — an India-only list in a product launching in
the US and Europe. A German user could not select German, which means the app
could not capture their meeting at all.

The list is asked of the engine rather than written down, because a
hand-maintained copy drifts from what the model can actually do. en and hi are
pinned to the top because a 99-item picker in raw engine order is unusable and
those two are what this product is measured on."
```

---

## Definition of done

- [ ] `ctest --test-dir cpp/cli/build` — 9/9 pass
- [ ] `python3 eval/characterize.py` — clean against a baseline re-recorded only in Task 7
- [ ] Qwen produces a non-empty Devanagari transcript on `real-neosym-2026-08-19`
- [ ] The script histogram shows CJK near zero with the language hint on
- [ ] `grep -rn "sanitizeUtf8" cpp/asr/` returns only `asr_postprocess.cpp`
- [ ] Minutes come out in the requested language (Task 9)
- [ ] The Settings picker lists far more than three languages (Task 10)
- [ ] Android still builds: `cd android && ./gradlew assembleDebug`

## Not in this plan

Deliberately, per the spec: the Android JNI swap onto the factory, persisting AsrRun's
provenance into the meetings table, `ModelCatalog` multi-file
support, VPS mirroring, tier gating, and scoring against a corrected ground truth. The last of
those is blocked on a human correcting
`eval/fixtures/real-neosym-2026-08-19/truth.draft.txt`, and this plan makes that scoring a
one-flag operation the moment it lands.
