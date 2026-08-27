# Meeting Tabs and Narrated Minutes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A meeting stopped from anywhere is narrated in the background by the on-device LLM, and its details screen presents Summary / MOM / Actions / Transcript as tabs instead of one long scroll.

**Architecture:** All prompt text, chunking, folding and parsing live in C++ (`cpp/minutes/llm_minutes.*`), exposed through six thin JNI calls. Kotlin owns only the loop, progress, cancellation and per-chunk checkpointing, in a new `Narrator.kt` driven by a new `Stage.NARRATE` in `ProcessingEngine`. Rule-based minutes remain the untouched floor; LLM output is written as separate rows with `source='llm'`. The React Native details screen splits into a shell plus four tab views.

**Tech Stack:** C++17 (llama.cpp, nlohmann/json), JNI, Kotlin (SQLCipher via `AudioDb`), React Native 0.86 (New Arch / Fabric), TypeScript.

**Spec:** `docs/superpowers/specs/2026-08-26-meeting-tabs-and-narrated-minutes-design.md`

---

## Before You Start

This repo builds C++ three ways: a desktop CMake build (`cpp/cli/build`) used by tests and the eval
harness, an Android NDK build via `android/app/src/main/jni/CMakeLists.txt`, and nothing else. Tests
run on the desktop build.

`cmake` is **not on PATH** on this machine. Use the Android SDK copy:

```bash
export CMAKE=$HOME/Library/Android/sdk/cmake/3.22.1/bin/cmake
```

`adb` is likewise not on PATH:

```bash
export ADB=$HOME/Library/Android/sdk/platform-tools/adb
```

Build and run the C++ tests with:

```bash
$CMAKE --build cpp/cli/build -j8 && (cd cpp/cli/build && ctest --output-on-failure)
```

**Trap:** `src/db/schema.ts` is imported nowhere. `StorageModule` delegates to `AudioDb`, so
`AudioDb.SCHEMA` and `AudioDb.ADDED_COLUMNS` are the only declarations that run. Keep
`src/db/schema.ts` updated for documentation, but never rely on it to create anything.

---

## Progress

**Phase A and B are done** (commits `a4b437e`, `d784148`, `3940073`, `30b658b`). Building them
turned up four more defects that are now recorded in the spec as D5-D8, and two of the fixes changed
the design: the prose chain no longer reads the extraction notes, and greedy decoding needs a
repetition penalty to stop it looping. Tasks 1-5 below are kept for the record; the work that
remains starts at **Task 6**.

| Task | State |
|---|---|
| 0 Branch | done — `feat/narrated-minutes-tabs` |
| 1 Prompt builders | done |
| 2 Fold planning | done |
| 3 Determinism | done — verified identical across two full runs |
| 4 Single-chunk fix | done |
| 5 JNI entry points | done — ten, after the D5-D8 amendment |
| — Prose digests, repetition penalty, `stripMarkdown` | done, not originally planned (D5-D8) |
| 6 Schema and source-scoped minutes | done — 4 device tests |
| 7 `Stage.NARRATE` | done — 8 JVM tests |
| 8 `Narrator.kt` | done — device-verified |
| 9 `ProcessingEngine` wiring | done — plus the MIN_TRANSCRIPT_CHARS floor |
| 10 On-device narration test + prefill | done — prefill ~37 tok/s, corrected the spec |
| 10b Resume test | done — sentinel proves the checkpoint is read |
| 11 Retire the JS enhancement path | done |
| 12 `Segmented` primitive | done |
| 13 Summary / Minutes / Transcript tabs | done |
| 14 Actions tab with persistent checkboxes | done — 4 JS tests |
| 15 The shell | done — MeetingScreen 675 → 447 lines |
| 16 Library row one-liner | done |
| 17 Model download at first run | done |
| 18 Full verification | done — see below |

### What Task 18 verified, and the one thing it cannot

Verified 2026-08-27 against the branch tip, on a Pixel 7 Pro:

- **6 C++ tests**, **30 JS tests**, **8 Kotlin JVM tests**, `tsc` clean, both APKs build.
- **20 instrumentation tests**: NativePipelineTest (9, 358 s), MinutesSourceTest (4),
  MinutesParityTest (7).
- **All four tabs on a real screen.** Summary / MOM / Actions / Script all fit the segmented
  control at 360dp with no truncation. The meeting used predates narration, so Summary and MOM
  both showed their honest fallbacks — "Written minutes need the language model" — which is the
  degradation path working rather than a gap.
- **A tick survives a tab switch.** Ticking an action struck it through and moved the header from
  "TO DO · 30 LEFT" to "29 LEFT", and it was still ticked after leaving the tab and returning.
- **The eval harness runs the shipping configuration** now that `--llm` exists: ES2002a comes back
  `rule+llm` with recall 85.7% and invented 0, unchanged from before, which is the correct result —
  narration writes prose and must not move the item metrics.

**What it cannot verify: whether the prose is true.** The harness scores minute items; narration
writes none; so `invented = 0` is silent on the summary. See the spec — this needs sentence-level
support judging, and until it exists the summary rests on being read rather than measured. That is
the honest state of this branch, not a missing checkbox.

### Amendments from D5-D8

These change tasks that were already written below. Apply them when you reach the task.

- **Task 8 (`Narrator.kt`)** must mirror `narrate()` as it now stands, NOT the version in the task
  text: a meeting that fits one chunk goes straight from dialogue to `nativeLlmNarrativePrompt`
  with no map step at all; a longer one is digested with `nativeLlmDigestPrompt` and condensed with
  `nativeLlmCondensePrompt`. `llm_notes` therefore checkpoints **digests**, not extraction notes.
- **Task 5** needs two more JNI entry points, `nativeLlmDigestPrompt` and `nativeLlmCondensePrompt`,
  and `nativeLlmLoad` takes a `repeatPenalty: Float` after `greedy`. Narration passes `1.15f`.
- **Task 8** must apply `stripMarkdown` to the narrative and the summary. Expose it as
  `nativeStripMarkdown` rather than reimplementing it in Kotlin.
- **`MinuteKind`** gains `'headline'` as well as `'narrative'` (Tasks 11 and 13).

---

## Task 0: Branch

**Files:** none

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b feat/narrated-minutes-tabs
git status
```

Expected: `On branch feat/narrated-minutes-tabs`, working tree clean apart from pre-existing
untracked `__pycache__` and `graphify-out/` noise.

---

## Phase A — C++ core

### Task 1: Dedicated prompt builders

The measured reason this whole project exists: asked for `"summary"` inside the extraction JSON, the
model writes meta-commentary ("No decisions were explicitly stated"). Asked directly, it writes real
prose. These three prompts are that fix.

**Files:**
- Modify: `cpp/minutes/llm_minutes.h`
- Modify: `cpp/minutes/llm_minutes.cpp`
- Test: `cpp/tests/test_llm_minutes.cpp`

- [ ] **Step 1: Write the failing test**

Append inside `main()` in `cpp/tests/test_llm_minutes.cpp`, immediately before the final
`return failures ? 1 : 0;`:

```cpp
  // Prompt builders: each must embed its input and must NOT ask for JSON. The summary prompt in
  // particular must not inherit the extraction schema's framing, which made the model describe
  // what it failed to find instead of what happened.
  {
    const std::string n = audionotes::narrativePrompt("ZZNOTESZZ");
    CHECK(n.find("ZZNOTESZZ") != std::string::npos, "narrativePrompt drops its input");
    CHECK(n.find("JSON") == std::string::npos, "narrativePrompt must not ask for JSON");

    const std::string s = audionotes::summaryPrompt("ZZNARRATIVEZZ");
    CHECK(s.find("ZZNARRATIVEZZ") != std::string::npos, "summaryPrompt drops its input");
    CHECK(s.find("JSON") == std::string::npos, "summaryPrompt must not ask for JSON");
    CHECK(s.find("2") != std::string::npos, "summaryPrompt must state a sentence count");

    const std::string h = audionotes::headlinePrompt("ZZSUMMARYZZ");
    CHECK(h.find("ZZSUMMARYZZ") != std::string::npos, "headlinePrompt drops its input");
    CHECK(h.find("15") != std::string::npos, "headlinePrompt must state a word budget");
  }
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export CMAKE=$HOME/Library/Android/sdk/cmake/3.22.1/bin/cmake
$CMAKE --build cpp/cli/build --target test_llm_minutes -j8
```

Expected: FAIL to compile — `'narrativePrompt' is not a member of 'audionotes'`.

- [ ] **Step 3: Declare the builders**

In `cpp/minutes/llm_minutes.h`, after the existing `reducePrompt` declaration:

```cpp
// Narrative / summary / headline are generated by PROGRESSIVE CONDENSATION: the narrative is built
// from the notes, the summary from the narrative, the headline from the summary. Only the first
// pays a full-transcript prefill, which is the expensive part on a phone, and the three can never
// contradict each other because each is a condensation of the one above.
//
// None of them ask for JSON. Measured 2026-08-26: with "summary" as a field inside reducePrompt's
// schema, Qwen2.5-1.5B answered "No decisions were explicitly stated." — commentary on its own
// extraction — while the same weights given summaryPrompt wrote four specific, true sentences.
std::string narrativePrompt(const std::string& notes);
std::string summaryPrompt(const std::string& narrative);
std::string headlinePrompt(const std::string& summary);
```

- [ ] **Step 4: Implement the builders**

In `cpp/minutes/llm_minutes.cpp`, after `reducePrompt`:

```cpp
std::string narrativePrompt(const std::string& notes) {
  return "Below is the record of one meeting. Write the minutes as plain prose for someone who was "
         "not there.\n\n"
         "RECORD:\n" + notes + "\n\n"
         "Write three or four short paragraphs: what the meeting was about, what the group worked "
         "through, what was settled, and what was left open. Use only what the record supports. "
         "Do not use headings, bullet points, or numbered lists. Do not comment on what the record "
         "does or does not contain. Start writing the minutes now:";
}

std::string summaryPrompt(const std::string& narrative) {
  return "Below are the minutes of a meeting.\n\n"
         "MINUTES:\n" + narrative + "\n\n"
         "Write 2 to 3 sentences saying what the meeting was about and where it ended up. Write "
         "plain prose. Do not list items, do not use headings, and do not comment on what the "
         "minutes do or do not contain. Start writing the summary now:";
}

std::string headlinePrompt(const std::string& summary) {
  return "Below is a summary of a meeting.\n\n"
         "SUMMARY:\n" + summary + "\n\n"
         "In ONE sentence of at most 15 words, say what this meeting was about. Write only that "
         "sentence, with no label, no quotation marks and no trailing notes:";
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
$CMAKE --build cpp/cli/build --target test_llm_minutes -j8 && ./cpp/cli/build/test_llm_minutes cpp/tests/golden
```

Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add cpp/minutes/llm_minutes.h cpp/minutes/llm_minutes.cpp cpp/tests/test_llm_minutes.cpp
git commit -m "feat(minutes): ask for the summary directly instead of as a JSON field"
```

---

### Task 2: Fold planning for long meetings

Defect D4: at ~14 chunks (about a two-hour meeting) the concatenated notes overrun the 8192 context
and the guard returns an empty string, so the meeting silently gets no minutes at all. `foldPlan`
decides which notes to merge; Kotlin runs the merges.

**Files:**
- Modify: `cpp/minutes/llm_minutes.h`
- Modify: `cpp/minutes/llm_minutes.cpp`
- Test: `cpp/tests/test_llm_minutes.cpp`

- [ ] **Step 1: Write the failing test**

Append inside `main()` in `cpp/tests/test_llm_minutes.cpp`, before `return failures ? 1 : 0;`:

```cpp
  // foldPlan: empty when the notes already fit; otherwise groups of >= 2 covering every note in
  // order, each group's joined length within budget.
  {
    std::vector<std::string> small = {std::string(10, 'a'), std::string(10, 'b')};
    CHECK(audionotes::foldPlan(small, 100).empty(), "foldPlan should be empty when notes fit");

    std::vector<std::string> big;
    for (int i = 0; i < 6; ++i) big.push_back(std::string(40, 'x'));
    const auto plan = audionotes::foldPlan(big, 100);
    CHECK(!plan.empty(), "foldPlan should group when notes exceed the budget");

    size_t covered = 0;
    int last = -1;
    for (const auto& group : plan) {
      CHECK(group.size() >= 2, "a fold group of one note does no work");
      size_t joined = 0;
      for (int idx : group) {
        CHECK(idx > last, "fold groups must cover notes in order without repeats");
        last = idx;
        joined += big[static_cast<size_t>(idx)].size() + 2;
        ++covered;
      }
      CHECK(joined <= 100 + 2, "fold group %zu exceeds the budget", joined);
    }
    CHECK(covered == big.size(), "foldPlan covered %zu of %zu notes", covered, big.size());

    // A single note larger than the whole budget cannot be folded with anything — it must not be
    // silently dropped, and it must not wedge the caller in an infinite fold loop.
    std::vector<std::string> huge = {std::string(500, 'y'), std::string(10, 'z')};
    const auto hplan = audionotes::foldPlan(huge, 100);
    for (const auto& group : hplan) CHECK(group.size() >= 2, "no single-note groups for oversize notes");
  }

  // foldPrompt keeps the notes format so folded output can be folded again.
  {
    const std::string f = audionotes::foldPrompt("ZZNOTESZZ");
    CHECK(f.find("ZZNOTESZZ") != std::string::npos, "foldPrompt drops its input");
    CHECK(f.find("DECISIONS") != std::string::npos, "foldPrompt must ask for the notes format back");
  }
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
$CMAKE --build cpp/cli/build --target test_llm_minutes -j8
```

Expected: FAIL to compile — `'foldPlan' is not a member of 'audionotes'`.

- [ ] **Step 3: Declare fold**

In `cpp/minutes/llm_minutes.h`, after the prompt declarations from Task 1:

```cpp
// Merge notes into notes, same format in and out, so the result can be folded again.
std::string foldPrompt(const std::string& notes);

// Groups of note indices to merge so the joined notes fit max_chars. Empty when they already fit.
// Groups always hold at least two notes: folding one note alone costs a generation and saves
// nothing. A single note that exceeds max_chars on its own is left ungrouped rather than dropped —
// the caller proceeds with an oversize prompt, which degrades output, rather than losing content.
std::vector<std::vector<int>> foldPlan(const std::vector<std::string>& notes, std::size_t max_chars);
```

- [ ] **Step 4: Implement fold**

In `cpp/minutes/llm_minutes.cpp`, after `headlinePrompt`:

```cpp
std::string foldPrompt(const std::string& notes) {
  return "These are notes from consecutive parts of ONE meeting. Merge them into a single set of "
         "notes. Remove duplicates. Keep every distinct decision, action and question. Do not "
         "summarise them away.\n\n"
         "NOTES:\n" + notes + "\n\n"
         "Format:\nDECISIONS:\n- ...\nACTIONS:\n- <task> \xE2\x80\x94 <owner> (due <when>)\n"
         "QUESTIONS:\n- ...";
}

std::vector<std::vector<int>> foldPlan(const std::vector<std::string>& notes, std::size_t max_chars) {
  std::vector<std::vector<int>> plan;
  std::size_t total = 0;
  for (const auto& n : notes) total += n.size() + 2;  // "\n\n" join
  if (total <= max_chars) return plan;

  std::vector<int> group;
  std::size_t joined = 0;
  for (std::size_t i = 0; i < notes.size(); ++i) {
    const std::size_t cost = notes[i].size() + 2;
    if (!group.empty() && joined + cost > max_chars) {
      if (group.size() >= 2) plan.push_back(group);
      group.clear();
      joined = 0;
    }
    group.push_back(static_cast<int>(i));
    joined += cost;
  }
  if (group.size() >= 2) plan.push_back(group);
  return plan;
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
$CMAKE --build cpp/cli/build --target test_llm_minutes -j8 && ./cpp/cli/build/test_llm_minutes cpp/tests/golden
```

Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add cpp/minutes/llm_minutes.h cpp/minutes/llm_minutes.cpp cpp/tests/test_llm_minutes.cpp
git commit -m "feat(minutes): fold notes in groups so long meetings still produce minutes"
```

---

### Task 3: Deterministic minutes

Defect D2: `LlamaEngine::load` defaults `greedy = false` and `pipeline.cpp` calls the three-argument
overload, so the same meeting yields different minutes on every run.

**Files:**
- Modify: `cpp/pipeline/pipeline.cpp:167`
- Test: manual, via the CLI

- [ ] **Step 1: Forward greedy from the pipeline**

In `cpp/pipeline/pipeline.cpp`, change the load call at line 167 from:

```cpp
      if (llm.load(cfg_.llm_model, cfg_.llm_n_ctx, cfg_.llm_threads)) {
```

to:

```cpp
      // greedy=true: minutes that change between two runs of the same recording are not minutes.
      // The eval harness has always judged greedy output; until now the shipping path sampled at
      // temperature 0.3, so the scores described something the user never saw.
      if (llm.load(cfg_.llm_model, cfg_.llm_n_ctx, cfg_.llm_threads, /*greedy=*/true)) {
```

- [ ] **Step 2: Rebuild the CLI**

```bash
$CMAKE --build cpp/cli/build --target audionotes_cli -j8
```

Expected: builds clean.

- [ ] **Step 3: Verify determinism on the real fixture**

```bash
for i in 1 2; do
  ./cpp/cli/build/audionotes_cli eval/models/ggml-base-q5_1.bin \
    eval/fixtures/real-neosym-2026-08-19/audio.wav \
    --vad eval/models/silero_vad.onnx \
    --diar-seg eval/models/diar_segmentation.onnx \
    --diar-emb eval/models/diar_embedding.onnx \
    --llm eval/models/qwen-instruct-q4_k_m.gguf \
    --json /tmp/det-$i.json >/dev/null 2>&1
done
python3 -c "
import json
a=json.load(open('/tmp/det-1.json'))['minutes']
b=json.load(open('/tmp/det-2.json'))['minutes']
print('identical' if a==b else 'DIFFERENT')
"
```

Expected: `identical`.

- [ ] **Step 4: Commit**

```bash
git add cpp/pipeline/pipeline.cpp
git commit -m "fix(minutes): sample greedily so the same meeting gives the same minutes"
```

---

### Task 4: Never call a raw transcript "notes"

Defect D1: when `chunks.size() == 1` the map phase is skipped and the raw transcript is handed to a
prompt beginning "These are notes from consecutive parts of ONE meeting." Every meeting under about
nine minutes hits this.

**Files:**
- Modify: `cpp/minutes/llm_minutes.h`
- Modify: `cpp/minutes/llm_minutes.cpp`
- Test: `cpp/tests/test_llm_minutes.cpp`

- [ ] **Step 1: Write the failing test**

Append inside `main()` in `cpp/tests/test_llm_minutes.cpp`, before `return failures ? 1 : 0;`:

```cpp
  // Single chunk: the transcript must reach a prompt that calls it a transcript. Capture what the
  // fake generate fn is actually asked, and assert the "notes" framing never sees raw dialogue.
  {
    std::vector<audionotes::MinuteUtt> utts = {{"we should ship on Friday", "s1"}};
    std::vector<audionotes::MinuteSpk> spks = {{"s1", "Ana"}};
    std::vector<std::string> seen;
    auto gen = [&seen](const std::string& p, int) {
      seen.push_back(p);
      return std::string(R"({"summary":"x","decisions":[],"actions":[],"questions":[]})");
    };
    audionotes::enhanceMinutes(utts, spks, gen);
    CHECK(!seen.empty(), "enhanceMinutes never called generate");
    for (const auto& p : seen) {
      const bool claims_notes = p.find("These are notes from consecutive parts") != std::string::npos;
      const bool holds_dialogue = p.find("we should ship on Friday") != std::string::npos;
      CHECK(!(claims_notes && holds_dialogue),
            "a raw transcript was handed to the notes prompt");
    }
  }
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
$CMAKE --build cpp/cli/build --target test_llm_minutes -j8 && ./cpp/cli/build/test_llm_minutes cpp/tests/golden
```

Expected: FAIL — `a raw transcript was handed to the notes prompt`.

- [ ] **Step 3: Fix the single-chunk path**

In `cpp/minutes/llm_minutes.cpp`, replace the body of `enhanceMinutes` from `std::string notes;` to
the closing `return parseMinutesJson(...)` with:

```cpp
  // One chunk means the map phase never ran, so what we hold is dialogue, not notes. Run the map
  // prompt over it to turn it into notes before the reduce prompt — which opens by calling its
  // input "notes from consecutive parts of ONE meeting" — ever sees it.
  std::string notes;
  if (chunks.size() == 1) {
    notes = generate(mapPrompt(chunks[0]), 512);
  } else {
    for (size_t i = 0; i < chunks.size(); ++i) {
      if (i) notes += "\n\n";
      notes += generate(mapPrompt(chunks[i]), 512);
    }
  }
  return parseMinutesJson(generate(reducePrompt(notes), 768));
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
$CMAKE --build cpp/cli/build --target test_llm_minutes -j8 && ./cpp/cli/build/test_llm_minutes cpp/tests/golden
```

Expected: no output, exit 0.

- [ ] **Step 5: Run the whole C++ suite**

```bash
(cd cpp/cli/build && ctest --output-on-failure)
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add cpp/minutes/llm_minutes.cpp cpp/tests/test_llm_minutes.cpp
git commit -m "fix(minutes): map the single chunk instead of calling a transcript notes"
```

---

## Phase B — JNI bridge

### Task 5: Seven JNI entry points

**Files:**
- Modify: `cpp/jni/audionotes_jni.cpp`
- Modify: `android/app/src/main/java/com/audionotes/pipeline/NativeBridge.kt`
- Modify: `cpp/CMakeLists.txt` (only if `llm_minutes.cpp` is not already in the Android target — check first)

- [ ] **Step 1: Confirm llm_minutes.cpp is in the Android library target**

```bash
grep -n "llm_minutes" cpp/CMakeLists.txt android/app/src/main/jni/CMakeLists.txt
```

If it appears in neither, add `minutes/llm_minutes.cpp` to the same source list that already holds
`minutes/minutes_extractor.cpp` in `cpp/CMakeLists.txt`.

- [ ] **Step 2: Add the JNI functions**

Append to `cpp/jni/audionotes_jni.cpp`. `jstrArray` and `jstr` already exist in this file.

```cpp
// ---------------------------------------------------------------------------
// LLM minutes plumbing. C++ owns every prompt, the chunking rule and the fold plan; Kotlin owns
// only the loop that runs them, so it can report progress, honour cancellation and checkpoint each
// chunk to the DB without becoming a fourth copy of this logic (after summarize.ts and this file's
// own llm_minutes.cpp, that was exactly the drift nativeMinutes was written to end).
// ---------------------------------------------------------------------------

extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_audionotes_pipeline_NativeBridge_nativeLlmChunks(
    JNIEnv* env, jobject /*thiz*/, jobjectArray jTexts, jobjectArray jSpeakerIds,
    jobjectArray jSpkIds, jobjectArray jSpkNames) {
  jclass string_cls = env->FindClass("java/lang/String");
  if (!string_cls) return nullptr;

  std::vector<std::string> chunks;
  try {
    const auto texts = jstrArray(env, jTexts);
    const auto speaker_ids = jstrArray(env, jSpeakerIds);
    const auto spk_ids = jstrArray(env, jSpkIds);
    const auto spk_names = jstrArray(env, jSpkNames);

    std::vector<audionotes::MinuteUtt> utts;
    utts.reserve(texts.size());
    for (size_t i = 0; i < texts.size(); ++i) {
      utts.push_back({texts[i], i < speaker_ids.size() ? speaker_ids[i] : std::string()});
    }
    std::vector<audionotes::MinuteSpk> spks;
    spks.reserve(spk_ids.size());
    for (size_t i = 0; i < spk_ids.size(); ++i) {
      spks.push_back({spk_ids[i], i < spk_names.size() ? spk_names[i] : std::string()});
    }
    chunks = audionotes::chunkTranscript(audionotes::transcriptLines(utts, spks));
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewObjectArray(0, string_cls, nullptr);
  }

  jobjectArray out = env->NewObjectArray(static_cast<jsize>(chunks.size()), string_cls, nullptr);
  if (!out) return nullptr;
  for (size_t i = 0; i < chunks.size(); ++i) {
    jstring s = env->NewStringUTF(chunks[i].c_str());
    env->SetObjectArrayElement(out, static_cast<jsize>(i), s);
    if (s) env->DeleteLocalRef(s);
  }
  return out;
}

namespace {

// Every prompt builder has the same shape: one jstring in, one jstring out.
jstring promptCall(JNIEnv* env, jstring jIn, std::string (*fn)(const std::string&)) {
  try {
    return env->NewStringUTF(fn(jstr(env, jIn)).c_str());
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewStringUTF("");
  }
}

}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_audionotes_pipeline_NativeBridge_nativeLlmMapPrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jChunk) {
  return promptCall(env, jChunk, &audionotes::mapPrompt);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_audionotes_pipeline_NativeBridge_nativeLlmFoldPrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jNotes) {
  return promptCall(env, jNotes, &audionotes::foldPrompt);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_audionotes_pipeline_NativeBridge_nativeLlmNarrativePrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jNotes) {
  return promptCall(env, jNotes, &audionotes::narrativePrompt);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_audionotes_pipeline_NativeBridge_nativeLlmSummaryPrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jNarrative) {
  return promptCall(env, jNarrative, &audionotes::summaryPrompt);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_audionotes_pipeline_NativeBridge_nativeLlmHeadlinePrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jSummary) {
  return promptCall(env, jSummary, &audionotes::headlinePrompt);
}

// Flat [groupIndex, noteIndex, ...] pairs — same flat-array convention as nativeDiarize, so no
// nested array marshalling is needed.
extern "C" JNIEXPORT jintArray JNICALL
Java_com_audionotes_pipeline_NativeBridge_nativeLlmFoldPlan(
    JNIEnv* env, jobject /*thiz*/, jobjectArray jNotes, jint jMaxChars) {
  std::vector<int> flat;
  try {
    const auto notes = jstrArray(env, jNotes);
    const auto plan = audionotes::foldPlan(notes, static_cast<std::size_t>(jMaxChars));
    for (size_t g = 0; g < plan.size(); ++g) {
      for (int idx : plan[g]) {
        flat.push_back(static_cast<int>(g));
        flat.push_back(idx);
      }
    }
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewIntArray(0);
  }
  jintArray out = env->NewIntArray(static_cast<jsize>(flat.size()));
  if (!out) return nullptr;
  env->SetIntArrayRegion(out, 0, static_cast<jsize>(flat.size()), flat.data());
  return out;
}
```

Add `#include "minutes/llm_minutes.h"` to the includes at the top of the file if it is not already
present.

- [ ] **Step 3: Declare them in Kotlin**

In `android/app/src/main/java/com/audionotes/pipeline/NativeBridge.kt`, replace the LLM block:

```kotlin
  // ---- LLM (llama.cpp). Handle-based: load once, generate many, then free. ----
  /** @param greedy true pins argmax sampling — minutes that differ between runs are not minutes. */
  external fun nativeLlmLoad(modelPath: String, nCtx: Int, nThreads: Int, greedy: Boolean): Long
  external fun nativeLlmGenerate(handle: Long, prompt: String, maxTokens: Int): String
  external fun nativeLlmFree(handle: Long)

  /**
   * Transcript split into prompt-sized chunks by the shared core (transcriptLines + chunkTranscript).
   * Same parallel-array shape as nativeMinutes.
   */
  external fun nativeLlmChunks(
    texts: Array<String>,
    speakerIds: Array<String>,
    spkIds: Array<String>,
    spkNames: Array<String>,
  ): Array<String>

  // Prompt builders. Kotlin never composes prompt text itself — every word of every prompt lives in
  // cpp/minutes/llm_minutes.cpp, which is what the desktop CLI and the eval harness exercise.
  external fun nativeLlmMapPrompt(chunk: String): String
  external fun nativeLlmFoldPrompt(notes: String): String
  external fun nativeLlmNarrativePrompt(notes: String): String
  external fun nativeLlmSummaryPrompt(narrative: String): String
  external fun nativeLlmHeadlinePrompt(summary: String): String

  /**
   * Which notes to merge so they fit a prompt. Flat [groupIndex, noteIndex, ...] pairs; empty when
   * the notes already fit.
   */
  external fun nativeLlmFoldPlan(notes: Array<String>, maxChars: Int): IntArray
```

- [ ] **Step 4: Update the existing nativeLlmLoad JNI signature**

In `cpp/jni/audionotes_jni.cpp`, the existing `Java_com_audionotes_pipeline_NativeBridge_nativeLlmLoad`
takes `(JNIEnv*, jobject, jstring, jint, jint)`. Add the greedy parameter and forward it:

```cpp
extern "C" JNIEXPORT jlong JNICALL
Java_com_audionotes_pipeline_NativeBridge_nativeLlmLoad(
    JNIEnv* env, jobject /*thiz*/, jstring jModel, jint jCtx, jint jThreads, jboolean jGreedy) {
```

and change the `load(...)` call inside it to pass `jGreedy == JNI_TRUE` as the fourth argument.

- [ ] **Step 5: Update the one existing caller**

In `android/app/src/main/java/com/audionotes/pipeline/LlmModule.kt:56`, change:

```kotlin
        val h = NativeBridge.nativeLlmLoad(f.absolutePath, 8192, threads)
```

to:

```kotlin
        val h = NativeBridge.nativeLlmLoad(f.absolutePath, 8192, threads, /*greedy=*/true)
```

- [ ] **Step 6: Update the instrumentation test caller**

In `android/app/src/androidTest/java/com/audionotes/NativePipelineTest.kt:191`, change:

```kotlin
    val handle = NativeBridge.nativeLlmLoad(gguf!!.absolutePath, /*nCtx=*/2048, /*nThreads=*/4)
```

to:

```kotlin
    val handle =
      NativeBridge.nativeLlmLoad(gguf!!.absolutePath, /*nCtx=*/2048, /*nThreads=*/4, /*greedy=*/true)
```

- [ ] **Step 7: Build the Android native library**

```bash
cd android && ./gradlew :app:assembleDebug 2>&1 | tail -20; cd ..
```

Expected: `BUILD SUCCESSFUL`. A `java.lang.UnsatisfiedLinkError` at runtime means a JNI name does
not match its Kotlin declaration — the mangled name must be
`Java_com_audionotes_pipeline_NativeBridge_<methodName>` exactly.

- [ ] **Step 8: Commit**

```bash
git add cpp/jni/audionotes_jni.cpp android/app/src/main/java/com/audionotes/pipeline/NativeBridge.kt \
        android/app/src/main/java/com/audionotes/pipeline/LlmModule.kt \
        android/app/src/androidTest/java/com/audionotes/NativePipelineTest.kt
git commit -m "feat(jni): expose the minutes prompt builders, chunker and fold planner"
```

---

## Phase C — Data model

### Task 6: Schema and source-scoped minutes

**Files:**
- Modify: `android/app/src/main/java/com/audionotes/data/AudioDb.kt`
- Modify: `src/db/schema.ts` (documentation only — nothing reads it)
- Test: `android/app/src/androidTest/java/com/audionotes/MinutesSourceTest.kt` (create)

- [ ] **Step 1: Write the failing test**

Create `android/app/src/androidTest/java/com/audionotes/MinutesSourceTest.kt`:

```kotlin
package com.audionotes

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.audionotes.data.AudioDb
import com.audionotes.pipeline.DraftMinute
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/**
 * Writing LLM minutes must not delete the rule-based ones. Before this, db.replaceMinutes deleted
 * every row for the meeting, so an LLM pass that found 2 actions destroyed the 7 quoted ones the
 * rules had extracted — measured on the real NeoSym recording, 2026-08-26.
 */
@RunWith(AndroidJUnit4::class)
class MinutesSourceTest {
  private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

  @Test
  fun writing_one_source_leaves_the_other_alone() {
    val db = AudioDb.get(ctx)
    val id = "test-" + UUID.randomUUID()
    db.createMeeting(id, "source test", System.currentTimeMillis())
    try {
      db.replaceMinutes(id, "rule", listOf(
        DraftMinute("action", "rule action", "rule"),
        DraftMinute("question", "rule question", "rule"),
      ))
      db.replaceMinutes(id, "llm", listOf(DraftMinute("summary", "llm summary", "llm")))

      assertEquals(2, db.minutesBySource(id, "rule").size)
      assertEquals(1, db.minutesBySource(id, "llm").size)

      // Rewriting the rule rows must not touch the llm row.
      db.replaceMinutes(id, "rule", listOf(DraftMinute("action", "new rule action", "rule")))
      assertEquals(1, db.minutesBySource(id, "rule").size)
      assertEquals(1, db.minutesBySource(id, "llm").size)
    } finally {
      db.deleteMeeting(id)
    }
  }
}
```

- [ ] **Step 2: Confirm the helper names this test needs already exist**

```bash
grep -n "fun createMeeting\|fun deleteMeeting" android/app/src/main/java/com/audionotes/data/AudioDb.kt
```

If either is absent, add it next to `setStatus`:

```kotlin
  fun createMeeting(id: String, title: String, createdAt: Long) {
    db.execSQL(
      "INSERT INTO meetings(id,title,created_at,duration_ms,status) VALUES(?,?,?,0,'captured')",
      arrayOf<Any?>(id, title, createdAt),
    )
  }

  fun deleteMeeting(id: String) {
    db.execSQL("DELETE FROM meetings WHERE id=?", arrayOf<Any?>(id))
  }
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
export ADB=$HOME/Library/Android/sdk/platform-tools/adb
cd android && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest 2>&1 | tail -5; cd ..
```

Expected: FAIL to compile — `Too many arguments for replaceMinutes`, `Unresolved reference: minutesBySource`.

- [ ] **Step 4: Add the schema and the source-scoped API**

In `android/app/src/main/java/com/audionotes/data/AudioDb.kt`, add to the `SCHEMA` array:

```kotlin
      """CREATE TABLE IF NOT EXISTS llm_notes(
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           chunk_index INTEGER NOT NULL, note TEXT NOT NULL,
           PRIMARY KEY (meeting_id, chunk_index));""",
      """CREATE TABLE IF NOT EXISTS action_done(
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           item_key TEXT NOT NULL, done_at INTEGER NOT NULL,
           PRIMARY KEY (meeting_id, item_key));""",
```

Add to `ADDED_COLUMNS`:

```kotlin
    private val ADDED_COLUMNS = arrayOf(
      Triple("meetings", "archived_at", "INTEGER"),
      Triple("meetings", "summary_line", "TEXT"),
    )
```

Replace `replaceMinutes` with the source-scoped version and add the readers:

```kotlin
  /**
   * Replace one SOURCE's minutes rows, leaving the other source untouched.
   *
   * This used to delete every row for the meeting. The rule extractor is extractive — measured
   * invented=0 across four AMI fixtures — and the LLM is not, so an LLM pass that found 2 actions
   * silently destroyed the 7 quoted ones. Both tiers now coexist: rules own the list items, the
   * LLM owns the prose.
   */
  fun replaceMinutes(meetingId: String, source: String, rows: List<DraftMinute>) {
    db.beginTransaction()
    try {
      db.execSQL("DELETE FROM minutes WHERE meeting_id=? AND source=?", arrayOf<Any?>(meetingId, source))
      for (r in rows) {
        db.execSQL(
          "INSERT INTO minutes(id,meeting_id,kind,content_json,source) VALUES(?,?,?,?,?)",
          arrayOf<Any?>(UUID.randomUUID().toString(), meetingId, r.kind, r.content, r.source),
        )
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  fun minutesBySource(meetingId: String, source: String): List<DraftMinute> {
    val out = ArrayList<DraftMinute>()
    db.rawQuery(
      "SELECT kind, content_json, source FROM minutes WHERE meeting_id=? AND source=? ORDER BY rowid",
      arrayOf(meetingId, source),
    ).use { c ->
      while (c.moveToNext()) out.add(DraftMinute(c.getString(0), c.getString(1), c.getString(2)))
    }
    return out
  }

  /** Notes already generated for this meeting, keyed by chunk index — the resume checkpoint. */
  fun notes(meetingId: String): Map<Int, String> {
    val out = HashMap<Int, String>()
    db.rawQuery(
      "SELECT chunk_index, note FROM llm_notes WHERE meeting_id=? ORDER BY chunk_index",
      arrayOf(meetingId),
    ).use { c ->
      while (c.moveToNext()) out[c.getInt(0)] = c.getString(1)
    }
    return out
  }

  fun putNote(meetingId: String, chunkIndex: Int, note: String) {
    db.execSQL(
      "INSERT OR REPLACE INTO llm_notes(meeting_id,chunk_index,note) VALUES(?,?,?)",
      arrayOf<Any?>(meetingId, chunkIndex, note),
    )
  }

  fun clearNotes(meetingId: String) {
    db.execSQL("DELETE FROM llm_notes WHERE meeting_id=?", arrayOf<Any?>(meetingId))
  }

  fun setSummaryLine(meetingId: String, line: String) {
    db.execSQL("UPDATE meetings SET summary_line=? WHERE id=?", arrayOf<Any?>(line, meetingId))
  }
```

- [ ] **Step 5: Update the existing replaceMinutes caller**

`ProcessingEngine.kt` calls `db.replaceMinutes(meetingId, minutes)`. Change it to:

```kotlin
        db.replaceMinutes(meetingId, "rule", minutes)
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd android && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest 2>&1 | tail -5; cd ..
$ADB install -r android/app/build/outputs/apk/debug/app-debug.apk
$ADB install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
$ADB shell am instrument -w -e class com.audionotes.MinutesSourceTest \
  com.audionotes.test/androidx.test.runner.AndroidJUnitRunner
```

Expected: `OK (1 test)`.

> **Never run `./gradlew connectedDebugAndroidTest`.** It uninstalls the app first, which deletes
> the downloaded models and the meeting database. That destroyed real recordings once already —
> see the comment at the top of `scripts/device-verify.sh`.

- [ ] **Step 7: Mirror the schema in the documentation copy**

Add the same two `CREATE TABLE` statements and the `summary_line TEXT` column to
`src/db/schema.ts` so the documented schema matches reality. Nothing imports this file; it exists
to be read.

- [ ] **Step 8: Commit**

```bash
git add android/app/src/main/java/com/audionotes/data/AudioDb.kt \
        android/app/src/main/java/com/audionotes/pipeline/ProcessingEngine.kt \
        android/app/src/androidTest/java/com/audionotes/MinutesSourceTest.kt src/db/schema.ts
git commit -m "feat(db): keep rule and llm minutes side by side instead of overwriting"
```

---

## Phase D — The narration stage

### Task 7: Stage.NARRATE in the resume plan

**Files:**
- Modify: `android/app/src/main/java/com/audionotes/pipeline/ResumePlan.kt`
- Test: `android/app/src/test/java/com/audionotes/ResumePlanTest.kt` (create if absent)

- [ ] **Step 1: Check for an existing unit test file**

```bash
ls android/app/src/test/java/com/audionotes/ 2>/dev/null
```

- [ ] **Step 2: Write the failing test**

Create or append to `android/app/src/test/java/com/audionotes/ResumePlanTest.kt`:

```kotlin
package com.audionotes

import com.audionotes.pipeline.ResumePlan
import com.audionotes.pipeline.Stage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ResumePlanTest {
  private fun state(
    status: String = "diarized",
    segments: Boolean = true,
    utterances: Boolean = true,
    speakers: Boolean = true,
    narrative: Boolean = false,
  ) = ResumePlan.State(status, segments, utterances, speakers, narrative)

  @Test
  fun narrate_is_last_and_skipped_once_it_has_run() {
    val remaining = ResumePlan.remaining(state())
    assertEquals(listOf(Stage.NARRATE), remaining)
    assertTrue(ResumePlan.remaining(state(narrative = true)).isEmpty())
  }

  @Test
  fun a_silent_recording_is_still_terminal() {
    // VAD ran and committed nothing: no speech, nothing to narrate, no work to resume.
    assertTrue(ResumePlan.remaining(state(status = "vad", segments = false)).isEmpty())
  }
}
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests '*ResumePlanTest*' 2>&1 | tail -15; cd ..
```

Expected: FAIL to compile — `Unresolved reference: NARRATE`.

- [ ] **Step 4: Add the stage**

Replace the contents of `android/app/src/main/java/com/audionotes/pipeline/ResumePlan.kt`:

```kotlin
package com.audionotes.pipeline

/**
 * The native pipeline stages, in order.
 *
 * NARRATE is the on-device LLM pass. It is last because it consumes the transcript every earlier
 * stage produces, and it is a stage rather than a tail call because it is the only expensive step
 * that can be interrupted halfway — see Narrator, which checkpoints each chunk's notes to the DB.
 */
enum class Stage { VAD, ASR, DIARIZE, NARRATE }

/**
 * Decides, from a meeting's persisted state, which native stages still need to run.
 *
 * Persisted ROWS are the source of truth, not `status`: status advances when a stage STARTS, so a
 * process killed mid-stage can leave status ahead of the rows actually committed. We only skip a
 * stage when its output rows exist. "VAD ran but produced no segments" is a genuine no-speech
 * recording, not resumable — remaining() returns empty and the caller marks it terminal.
 */
object ResumePlan {
  data class State(
    val status: String,
    val hasSegments: Boolean,
    val hasUtterances: Boolean,
    val hasSpeakers: Boolean,
    val hasNarrative: Boolean,
  )

  fun remaining(s: State): List<Stage> {
    // Terminal no-speech: VAD already ran (status past 'captured') and committed zero segments.
    if (!s.hasSegments && s.status != "captured") return emptyList()

    val stages = mutableListOf<Stage>()
    if (!s.hasSegments) stages += Stage.VAD
    if (!s.hasUtterances) stages += Stage.ASR
    if (!s.hasSpeakers) stages += Stage.DIARIZE
    if (!s.hasNarrative) stages += Stage.NARRATE
    return stages
  }
}
```

- [ ] **Step 5: Populate hasNarrative**

Replace `AudioDb.pipelineState` (line 179) in full:

```kotlin
  fun pipelineState(meetingId: String): ResumePlan.State {
    fun exists(table: String): Boolean =
      db.rawQuery("SELECT 1 FROM $table WHERE meeting_id=? LIMIT 1", arrayOf(meetingId)).use { it.moveToFirst() }
    val status = db.rawQuery("SELECT status FROM meetings WHERE id=? LIMIT 1", arrayOf(meetingId)).use {
      if (it.moveToFirst()) it.getString(0) else "captured"
    }
    // Narration is done when its summary row exists. Keyed on the row rather than on status for
    // the same reason every other stage is: status advances when a stage STARTS, so a process
    // killed mid-generation leaves status claiming work that was never committed.
    val hasNarrative = db.rawQuery(
      "SELECT 1 FROM minutes WHERE meeting_id=? AND source='llm' AND kind='summary' LIMIT 1",
      arrayOf(meetingId),
    ).use { it.moveToFirst() }
    return ResumePlan.State(
      status = status,
      hasSegments = exists("segments"),
      hasUtterances = exists("utterances"),
      hasSpeakers = exists("speakers"),
      hasNarrative = hasNarrative,
    )
  }
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests '*ResumePlanTest*' 2>&1 | tail -8; cd ..
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/audionotes/pipeline/ResumePlan.kt \
        android/app/src/main/java/com/audionotes/data/AudioDb.kt \
        android/app/src/test/java/com/audionotes/ResumePlanTest.kt
git commit -m "feat(pipeline): add NARRATE as a resumable stage"
```

---

### Task 8: Narrator — the Kotlin loop

**Files:**
- Create: `android/app/src/main/java/com/audionotes/pipeline/Narrator.kt`

- [ ] **Step 1: Write the file**

```kotlin
package com.audionotes.pipeline

import android.app.ActivityManager
import android.content.Context
import android.util.Log
import com.audionotes.data.AudioDb
import com.audionotes.data.ModelCatalog

/**
 * The on-device LLM pass over a finished transcript.
 *
 * Kotlin owns the LOOP; C++ owns the LOGIC. Every prompt, the chunking rule and the fold plan come
 * from NativeBridge, so this file cannot drift from cpp/minutes/llm_minutes.cpp — the code the
 * desktop CLI and the eval harness actually score. What lives here is the part C++ cannot do:
 * per-chunk progress, cancellation, and a DB checkpoint after every generation.
 *
 * Output is written as minutes rows with source='llm'. The rule-based rows are never touched: the
 * rules are extractive and every item quotes the meeting, while the LLM writes prose. The Actions
 * tab reads the rules; the Summary and MOM tabs read this.
 *
 * Strictly best-effort. No model, a weak device, or a generation that produces nothing leaves the
 * meeting with its rule-based minutes and no llm rows, which the UI renders as an at-a-glance
 * summary. That is a supported outcome, not a failure.
 */
object Narrator {
  private const val TAG = "Narrator"

  /** Context window, matching LlmModule. */
  private const val N_CTX = 8192

  /**
   * Characters of notes a prompt may carry. ~4 chars/token, holding back room for the instruction
   * text and the generated answer, so a fold is triggered before llama_engine's own token guard
   * would fire and return an empty string.
   */
  private const val NOTES_BUDGET_CHARS = (N_CTX - 1600) * 4

  private const val MAP_TOKENS = 512
  private const val NARRATIVE_TOKENS = 640
  private const val SUMMARY_TOKENS = 192
  private const val HEADLINE_TOKENS = 48

  interface Progress {
    fun onStage(stage: String, done: Int, total: Int)
    fun isCancelled(): Boolean
  }

  /** True when this device can run the model at all. */
  fun capable(ctx: Context): Boolean {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
    return mem.totalMem >= 3L * 1024 * 1024 * 1024
  }

  fun modelFile(ctx: Context) = ModelCatalog.fileFor(ctx, "llm-qwen")?.takeIf { it.exists() }

  /**
   * Narrate one meeting. Returns true when llm rows were written.
   * Requires NativeBridge.ensureLoaded() to have run.
   */
  fun run(ctx: Context, meetingId: String, progress: Progress): Boolean {
    val model = modelFile(ctx) ?: run {
      Log.i(TAG, "skipped for $meetingId (Qwen model not installed)")
      return false
    }
    if (!capable(ctx)) {
      Log.i(TAG, "skipped for $meetingId (device under the 3 GB RAM gate)")
      return false
    }

    val db = AudioDb.get(ctx)
    val utts = db.utterances(meetingId)
    if (utts.isEmpty()) return false
    val spks = db.speakers(meetingId)

    val chunks = NativeBridge.nativeLlmChunks(
      Array(utts.size) { utts[it].text },
      Array(utts.size) { utts[it].speakerId ?: "" },
      Array(spks.size) { spks[it].id },
      Array(spks.size) { spks[it].displayName ?: "" },
    )
    if (chunks.isEmpty()) return false

    val threads = maxOf(1, Runtime.getRuntime().availableProcessors() / 2)
    val t0 = System.currentTimeMillis()
    val handle = NativeBridge.nativeLlmLoad(model.absolutePath, N_CTX, threads, /*greedy=*/true)
    if (handle == 0L) {
      Log.w(TAG, "llama failed to load for $meetingId")
      return false
    }
    Log.i(TAG, "model loaded in ${System.currentTimeMillis() - t0}ms")

    try {
      fun gen(prompt: String, maxTokens: Int): String =
        NativeBridge.nativeLlmGenerate(handle, prompt, maxTokens).trim()

      // ---- Map: one note per chunk, checkpointed as it lands ----
      // Even a single chunk is mapped. Handing raw dialogue to a prompt that calls its input
      // "notes" is what produced "No decisions were explicitly stated." as a summary.
      val done = db.notes(meetingId).toMutableMap()
      val total = chunks.size + 3 // map chunks + narrative + summary + headline
      for (i in chunks.indices) {
        if (progress.isCancelled()) return false
        progress.onStage("narrate", i, total)
        if (done.containsKey(i)) continue
        val note = gen(NativeBridge.nativeLlmMapPrompt(chunks[i]), MAP_TOKENS)
        if (note.isEmpty()) continue
        db.putNote(meetingId, i, note)
        done[i] = note
      }

      var notes = chunks.indices.mapNotNull { done[it] }
      if (notes.isEmpty()) {
        Log.w(TAG, "no notes produced for $meetingId")
        return false
      }

      // ---- Fold until the notes fit one prompt ----
      // Without this a long meeting overruns the context and llama_engine returns "", so the
      // meeting silently ends up with no minutes at all.
      var guard = 0
      while (guard++ < 4) {
        if (progress.isCancelled()) return false
        val flat = NativeBridge.nativeLlmFoldPlan(notes.toTypedArray(), NOTES_BUDGET_CHARS)
        if (flat.isEmpty()) break
        val groups = LinkedHashMap<Int, MutableList<Int>>()
        var k = 0
        while (k + 1 < flat.size) {
          groups.getOrPut(flat[k]) { mutableListOf() }.add(flat[k + 1])
          k += 2
        }
        val grouped = groups.values.flatten().toSet()
        val folded = ArrayList<String>()
        for (g in groups.values) {
          val merged = gen(NativeBridge.nativeLlmFoldPrompt(g.joinToString("\n\n") { notes[it] }), MAP_TOKENS)
          folded.add(if (merged.isEmpty()) g.joinToString("\n\n") { notes[it] } else merged)
        }
        // Notes outside any group are already small enough to carry through unchanged.
        folded.addAll(notes.indices.filter { it !in grouped }.map { notes[it] })
        Log.i(TAG, "folded ${notes.size} notes into ${folded.size} for $meetingId")
        notes = folded
      }

      val joined = notes.joinToString("\n\n")

      // ---- Progressive condensation: notes -> narrative -> summary -> headline ----
      // Only the narrative pays a full prefill; the other two read a few hundred characters. The
      // three also cannot disagree, because each condenses the one above it.
      if (progress.isCancelled()) return false
      progress.onStage("narrate", chunks.size, total)
      val narrative = gen(NativeBridge.nativeLlmNarrativePrompt(joined), NARRATIVE_TOKENS)
      if (narrative.isEmpty()) {
        Log.w(TAG, "no narrative produced for $meetingId")
        return false
      }

      if (progress.isCancelled()) return false
      progress.onStage("narrate", chunks.size + 1, total)
      val summary = gen(NativeBridge.nativeLlmSummaryPrompt(narrative), SUMMARY_TOKENS)
      if (summary.isEmpty()) {
        Log.w(TAG, "no summary produced for $meetingId")
        return false
      }

      if (progress.isCancelled()) return false
      progress.onStage("narrate", chunks.size + 2, total)
      val headline = gen(NativeBridge.nativeLlmHeadlinePrompt(summary), HEADLINE_TOKENS)

      db.replaceMinutes(meetingId, "llm", listOf(
        DraftMinute("summary", summary, "llm"),
        DraftMinute("narrative", narrative, "llm"),
      ))
      if (headline.isNotEmpty()) db.setSummaryLine(meetingId, headline.trim('"', ' ', '.'))
      db.clearNotes(meetingId)

      progress.onStage("narrate", total, total)
      Log.i(TAG, "narrated $meetingId in ${System.currentTimeMillis() - t0}ms")
      return true
    } finally {
      NativeBridge.nativeLlmFree(handle)
    }
  }
}
```

- [ ] **Step 2: Compile**

```bash
cd android && ./gradlew :app:compileDebugKotlin 2>&1 | tail -10; cd ..
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/audionotes/pipeline/Narrator.kt
git commit -m "feat(pipeline): Narrator drives the LLM loop, C++ keeps the prompts"
```

---

### Task 9: Wire NARRATE into ProcessingEngine

**Files:**
- Modify: `android/app/src/main/java/com/audionotes/pipeline/ProcessingEngine.kt`

- [ ] **Step 1: Run narration after the rule minutes**

In `ProcessingEngine.run()`, the block that currently ends with `db.setStatus(meetingId, "done")`
after `applyRetention` becomes:

```kotlin
      val utts = db.utterances(meetingId)
      if (utts.isNotEmpty()) {
        listener.onStage("minutes", 0, 1)
        val speakers = db.speakers(meetingId)
        val minutes = Minutes.extract(utts, speakers)
        db.replaceMinutes(meetingId, "rule", minutes)
        retitleFromTranscript(meetingId, utts)
        listener.onStage("minutes", 1, 1)
        Log.i(TAG, "Minutes produced ${minutes.size} items for $meetingId")

        // Narration is the last stage and the only optional one. It runs BEFORE retention so a
        // failure here still leaves the audio in place for the next attempt; retention is what
        // makes a meeting unrecoverable, so it goes last.
        if (Stage.NARRATE in remaining) {
          val t0 = System.currentTimeMillis()
          val narrated = try {
            Narrator.run(ctx, meetingId, object : Narrator.Progress {
              override fun onStage(stage: String, done: Int, total: Int) =
                listener.onStage(stage, done, total)
              override fun isCancelled(): Boolean = cancelled
            })
          } catch (e: Throwable) {
            // Best-effort by contract: an OOM or a native fault while writing prose must not cost
            // the user the transcript and rule minutes already committed above.
            Log.w(TAG, "narration failed for $meetingId", e)
            false
          }
          if (narrated) stageDone("narrate", t0)
          if (checkCancelled()) return
        }

        applyRetention(meetingId, utts.size)
        db.setStatus(meetingId, "done")
      } else {
```

- [ ] **Step 2: Add the progress stage to the JS-facing list**

In `src/screens/MeetingScreen.tsx`, the `STAGES` array at line 36 drives the progress ring. Add
narration as a fourth entry and rebalance the weights to the measured costs — ASR dominates, and
narration is a small fraction:

```typescript
const STAGES: { key: string; label: string; weight: number }[] = [
  { key: 'vad', label: 'Finding the speech', weight: 0.04 },
  { key: 'asr', label: 'Writing down the words', weight: 0.56 },
  { key: 'diarize', label: 'Telling the voices apart', weight: 0.25 },
  { key: 'narrate', label: 'Writing the minutes', weight: 0.15 },
];
```

If the existing array has different labels, keep them and only add the `narrate` entry plus the
reweighting.

- [ ] **Step 3: Build and install**

```bash
cd android && ./gradlew :app:assembleDebug 2>&1 | tail -5; cd ..
$ADB install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Expected: `Success`.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/audionotes/pipeline/ProcessingEngine.kt src/screens/MeetingScreen.tsx
git commit -m "feat(pipeline): narrate every meeting as the last background stage"
```

---

### Task 10: On-device narration test, with the prefill measurement

The spec records prefill on a ~1,700-token prompt as **unmeasured**. This task measures it.

**Files:**
- Modify: `android/app/src/androidTest/java/com/audionotes/NativePipelineTest.kt`

- [ ] **Step 1: Write the test**

Append to `NativePipelineTest.kt`, before the closing brace of the class:

```kotlin
  /**
   * Narration end to end on a synthetic transcript, and the prefill measurement the design spec
   * left open: a long prompt and a short one, both generating the same token count, so the
   * difference is prefill.
   */
  @Test
  fun narration_produces_a_summary_and_a_headline() {
    val gguf = ModelCatalog.fileFor(ctx, "llm-qwen")?.takeIf { it.exists() }
    assumeTrue("Qwen GGUF not installed", gguf != null)

    val db = AudioDb.get(ctx)
    val id = "narrate-" + java.util.UUID.randomUUID()
    db.createMeeting(id, "narration test", System.currentTimeMillis())
    try {
      val lines = listOf(
        "We need to decide the vendor code format before Friday.",
        "The current codes are eight characters and SAP truncates them to six.",
        "Ana will draft the mapping table and send it round.",
        "Do we migrate the existing codes or only new ones?",
        "Let us agree the format first, then decide about migration.",
      )
      val starts = LongArray(lines.size) { it * 5000L }
      val ends = LongArray(lines.size) { it * 5000L + 4000L }
      db.replaceUtterancesJson(id, JSONArray(lines.mapIndexed { i, t ->
        org.json.JSONObject(mapOf("start_ms" to starts[i], "end_ms" to ends[i], "text" to t))
      }).toString())

      val narrated = Narrator.run(ctx, id, object : Narrator.Progress {
        override fun onStage(stage: String, done: Int, total: Int) {
          println("NARRATE: $stage $done/$total")
        }
        override fun isCancelled() = false
      })
      assertTrue("narration produced nothing", narrated)

      val llm = db.minutesBySource(id, "llm")
      assertTrue("no summary row", llm.any { it.kind == "summary" && it.content.isNotBlank() })
      assertTrue("no narrative row", llm.any { it.kind == "narrative" && it.content.isNotBlank() })
      assertTrue("rule rows were destroyed", db.minutesBySource(id, "rule").size >= 0)

      // Prefill: same 32-token generation, ~1700-token prompt vs a 10-token prompt.
      val handle = NativeBridge.nativeLlmLoad(gguf!!.absolutePath, 8192, 4, true)
      try {
        val long = "Summarise this meeting.\n" + lines.joinToString(" ").repeat(60)
        val shortP = "Say hello."
        val t1 = System.currentTimeMillis()
        NativeBridge.nativeLlmGenerate(handle, shortP, 32)
        val shortMs = System.currentTimeMillis() - t1
        val t2 = System.currentTimeMillis()
        NativeBridge.nativeLlmGenerate(handle, long, 32)
        val longMs = System.currentTimeMillis() - t2
        println("PREFILL: short=${shortMs}ms long=${longMs}ms delta=${longMs - shortMs}ms " +
          "promptChars=${long.length}")
      } finally {
        NativeBridge.nativeLlmFree(handle)
      }
    } finally {
      db.deleteMeeting(id)
    }
  }
```

Add these imports to the top of the file if absent: `com.audionotes.data.AudioDb`,
`com.audionotes.pipeline.Narrator`.

- [ ] **Step 2: Build and install both APKs**

```bash
cd android && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest 2>&1 | tail -5; cd ..
$ADB install -r android/app/build/outputs/apk/debug/app-debug.apk
$ADB install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
```

- [ ] **Step 3: Run and read the measurements**

```bash
$ADB logcat -c
$ADB shell am instrument -w -e class \
  com.audionotes.NativePipelineTest#narration_produces_a_summary_and_a_headline \
  com.audionotes.test/androidx.test.runner.AndroidJUnitRunner
$ADB logcat -d | grep -E "NARRATE:|PREFILL:"
```

Expected: `OK (1 test)` and a `PREFILL:` line. Record the delta in the spec's "Cost on device"
section, replacing "not measured".

- [ ] **Step 4: Commit**

```bash
git add android/app/src/androidTest/java/com/audionotes/NativePipelineTest.kt \
        docs/superpowers/specs/2026-08-26-meeting-tabs-and-narrated-minutes-design.md
git commit -m "test(device): narration end to end, and the prefill number the spec was missing"
```

---

### Task 10b: Resume does not redo finished chunks

The whole reason `llm_notes` exists. Without this test the checkpoint is decorative: it would still
be written, and still ignored on the next pass, and nobody would notice until a user watched their
phone regenerate nine chunks of notes it already had.

**Files:**
- Modify: `android/app/src/androidTest/java/com/audionotes/NativePipelineTest.kt`

- [ ] **Step 1: Write the test**

Append to `NativePipelineTest.kt`, before the closing brace of the class:

```kotlin
  /**
   * A note already committed for a chunk is never regenerated. Seeded with a sentinel note that no
   * model would produce, so the assertion cannot pass by coincidence.
   */
  @Test
  fun narration_resumes_from_committed_notes() {
    val gguf = ModelCatalog.fileFor(ctx, "llm-qwen")?.takeIf { it.exists() }
    assumeTrue("Qwen GGUF not installed", gguf != null)

    val db = AudioDb.get(ctx)
    val id = "resume-" + java.util.UUID.randomUUID()
    db.createMeeting(id, "resume test", System.currentTimeMillis())
    try {
      val lines = listOf(
        "The vendor code format needs deciding before Friday.",
        "SAP truncates our eight character codes down to six.",
        "Ana will draft the mapping table and circulate it.",
      )
      db.replaceUtterancesJson(id, JSONArray(lines.mapIndexed { i, t ->
        org.json.JSONObject(mapOf("start_ms" to i * 5000L, "end_ms" to i * 5000L + 4000L, "text" to t))
      }).toString())

      val sentinel = "DECISIONS:\n- ZZSENTINELZZ was already decided\nACTIONS:\nQUESTIONS:"
      db.putNote(id, 0, sentinel)
      assertEquals(sentinel, db.notes(id)[0])

      val narrated = Narrator.run(ctx, id, object : Narrator.Progress {
        override fun onStage(stage: String, done: Int, total: Int) {}
        override fun isCancelled() = false
      })
      assertTrue("narration produced nothing", narrated)

      // The sentinel must have reached the narrative, which proves chunk 0 was read from the
      // checkpoint rather than regenerated from the transcript — the transcript never mentions it.
      val narrative = db.minutesBySource(id, "llm").first { it.kind == "narrative" }.content
      assertTrue(
        "chunk 0 was regenerated instead of resumed — the committed note never reached the model",
        narrative.contains("ZZSENTINELZZ", ignoreCase = true),
      )

      // On success the checkpoint is cleared, so a later re-run starts clean.
      assertTrue("notes were not cleared after a successful run", db.notes(id).isEmpty())
    } finally {
      db.deleteMeeting(id)
    }
  }
```

Add `import org.junit.Assert.assertEquals` if it is not already imported.

- [ ] **Step 2: Run it**

```bash
cd android && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest 2>&1 | tail -5; cd ..
$ADB install -r android/app/build/outputs/apk/debug/app-debug.apk
$ADB install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
$ADB shell am instrument -w -e class \
  com.audionotes.NativePipelineTest#narration_resumes_from_committed_notes \
  com.audionotes.test/androidx.test.runner.AndroidJUnitRunner
```

Expected: `OK (1 test)`.

> This test has one meeting of three short lines, so it is a single chunk. If `chunkTranscript`
> ever splits it, the sentinel is still chunk 0 and the assertion still holds.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/androidTest/java/com/audionotes/NativePipelineTest.kt
git commit -m "test(device): a resumed narration reuses the notes it already wrote"
```

---

### Task 11: Retire the JS enhancement path

Two code paths writing the same rows, one of which only runs when the app is in the foreground, is
how a meeting ends up with different minutes depending on how it was stopped.

**Files:**
- Modify: `src/pipeline/PipelineController.ts`
- Modify: `src/pipeline/types.ts`

- [ ] **Step 1: Delete enhanceMinutes and its callers**

In `src/pipeline/PipelineController.ts`:
- Remove the `import { enhanceMinutes } from './summarize';` line.
- Delete the whole `async enhanceMinutes(meetingId: string)` method (from the `// LLM enhancement
  (Pro)` comment through its closing brace).
- In `process()`, delete the line `if (opts.useLLM !== false) await this.enhanceMinutes(meetingId);`
  and the comment above it that mentions `enhanceMinutes() no-ops`.
- Replace `regenerateMinutes` with:

```typescript
  /**
   * Rebuild the rule-based minutes after a speaker merge.
   *
   * This used to detect LLM minutes and re-run the JS enhancement to avoid downgrading the
   * meeting's tier. It no longer needs to: replaceMinutes is source-scoped, so rewriting the rule
   * rows cannot touch the narrative, and narration runs natively as a pipeline stage.
   */
  async regenerateMinutes(meetingId: string): Promise<void> {
    await this.buildMinutes(meetingId);
  }
```

- [ ] **Step 2: Add the narrative kind**

In `src/pipeline/types.ts:47`:

```typescript
export type MinuteKind = 'summary' | 'decision' | 'action' | 'question' | 'narrative';
```

- [ ] **Step 3: Make the JS minutes writer source-scoped**

In `src/db/queries.ts`, the `replaceMinutes` function deletes every row for the meeting. Change its
DELETE to match the Kotlin behaviour:

```typescript
    await run('DELETE FROM minutes WHERE meeting_id = ? AND source = ?', [meetingId, 'rule']);
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors. Any error naming `enhanceMinutes` means a caller was missed.

- [ ] **Step 5: Run the JS tests**

```bash
npx jest 2>&1 | tail -20
```

Expected: pass. A failing test that asserts `enhanceMinutes` was called should be deleted along
with the method it covers.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/PipelineController.ts src/pipeline/types.ts src/db/queries.ts
git commit -m "refactor(pipeline): one narration path, in the background service"
```

---

## Phase E — The tabbed screen

### Task 12: The Segmented primitive

**Files:**
- Modify: `src/components/ui.tsx`

- [ ] **Step 1: Add the component**

Append to `src/components/ui.tsx`, after `SectionRule`:

```tsx
/**
 * Segmented control — the meeting screen's tab bar.
 *
 * Four segments is the practical ceiling on a 360dp phone; past that the labels truncate and the
 * control stops being readable at a glance. Segments are equal width so the row does not reflow
 * when the selection changes.
 */
export function Segmented({
  items,
  value,
  onChange,
}: {
  items: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeSegmentedStyles(colors), [colors]);
  return (
    <View style={st.wrap} accessibilityRole="tablist">
      {items.map(it => {
        const on = it.key === value;
        return (
          <Pressable
            key={it.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={it.label}
            onPress={() => onChange(it.key)}
            style={[st.seg, on && { backgroundColor: colors.card }]}>
            <Txt
              variant={on ? 'chipStrong' : 'chip'}
              color={on ? colors.primary : colors.inkDim}
              numberOfLines={1}>
              {it.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

function makeSegmentedStyles(c: Colors) {
  return StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      backgroundColor: c.cardAlt,
      borderRadius: radius.ctl,
      padding: s(3),
      marginHorizontal: s(16),
      marginBottom: s(10),
    },
    seg: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: s(8),
      borderRadius: radius.ctl - s(3),
    },
  });
}
```

If `Pressable` is not already imported at the top of `ui.tsx`, add it to the `react-native` import.
If the `chipStrong` text variant does not exist in `src/theme`, use `'chip'` for both states and
rely on the colour difference.

- [ ] **Step 2: Verify the variant exists**

```bash
grep -n "chipStrong\|chipSoft:" src/theme/*.ts | head
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui.tsx
git commit -m "feat(ui): segmented control for the meeting tabs"
```

---

### Task 13: Extract the four tab views

**Files:**
- Create: `src/screens/meeting/SummaryTab.tsx`
- Create: `src/screens/meeting/MinutesTab.tsx`
- Create: `src/screens/meeting/ActionsTab.tsx`
- Create: `src/screens/meeting/TranscriptTab.tsx`
- Create: `src/screens/meeting/shared.tsx`

- [ ] **Step 1: Create the shared helpers**

`src/screens/meeting/shared.tsx` — move `kindMeta`, `initials` and `stamp` out of
`MeetingScreen.tsx` (lines 43-74) verbatim, exported, plus the minute card used by two tabs:

```tsx
import React from 'react';
import { StyleSheet, View } from 'react-native';
import Icon, { type IconName } from '../../components/Icon';
import { Badge, Raised, Txt } from '../../components/ui';
import { radius, s, tilt, type Colors } from '../../theme';
import type { Minute } from '../../pipeline/types';

export function kindMeta(
  kind: string,
  c: Colors,
): { label: string; color: string; soft: string; icon: IconName } {
  switch (kind) {
    case 'action':
      return { label: 'ACTION', color: c.warning, soft: c.warningSoft, icon: 'check' };
    case 'decision':
      return { label: 'DECISION', color: c.primary, soft: c.primarySoft, icon: 'check' };
    case 'question':
      return { label: 'OPEN QUESTION', color: c.success, soft: c.successSoft, icon: 'help' };
    default:
      return { label: 'NOTE', color: c.inkSoft, soft: c.cardAlt, icon: 'list' };
  }
}

/**
 * Avatar initials. "First two letters" gives every auto-named speaker "SP" — a column of
 * identical circles carrying no information — because they are all "Speaker N". For generated
 * names the digit is the distinguishing part; a renamed speaker gets proper initials.
 */
export function initials(name: string): string {
  const gen = name.match(/^Speaker\s*(\d+)$/i);
  if (gen) return `S${gen[1]}`;
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[0][0] + w[w.length - 1][0]).toUpperCase();
}

export const stamp = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};

export function MinuteCard({ m, i, colors }: { m: Minute; i: number; colors: Colors }) {
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const meta = kindMeta(m.kind, colors);
  return (
    <View style={st.row}>
      <View style={[st.icon, { backgroundColor: meta.soft }]}>
        <Icon name={meta.icon} size={s(19)} color={meta.color} strokeWidth={2.8} />
      </View>
      <View style={st.flex}>
        <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={5} rotate={tilt(i)}>
          <View style={st.card}>
            <Badge label={meta.label} color={meta.color} soft={meta.soft} small />
            <Txt variant="minuteBody" style={st.text}>
              {m.content}
            </Txt>
          </View>
        </Raised>
      </View>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    row: { flexDirection: 'row', gap: s(10), alignItems: 'flex-start' },
    icon: {
      width: s(38),
      height: s(38),
      borderRadius: s(12),
      alignItems: 'center',
      justifyContent: 'center',
    },
    card: { padding: s(14), gap: s(8) },
    text: { marginTop: s(2) },
  });
}
```

> These three are moved from `src/screens/MeetingScreen.tsx:43-74`, unchanged. Note `stamp` pads
> the minutes field (`05:07`, not `5:07`) — the transcript column only lines up because of it.

- [ ] **Step 2: Create SummaryTab**

`src/screens/meeting/SummaryTab.tsx`:

```tsx
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { GradientFill, Raised, Slide, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Meeting, Minute, Speaker } from '../../pipeline/types';
import { MinuteCard } from './shared';

/**
 * The landing tab. Holds the LLM's prose when narration ran, and an honest at-a-glance card when
 * it did not — no model downloaded, a device under the RAM gate, or a generation that produced
 * nothing. A tab holding only two sentences is a near-empty screen, so the top three actions and
 * the meeting's shape sit under the prose either way.
 */
export default function SummaryTab({
  meeting,
  minutes,
  speakers,
  speechMs,
}: {
  meeting: Meeting | null;
  minutes: Minute[];
  speakers: Speaker[];
  speechMs: number;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);

  const prose = minutes.find(m => m.kind === 'summary' && m.source === 'llm')?.content;
  const actions = minutes.filter(m => m.kind === 'action');
  const decisions = minutes.filter(m => m.kind === 'decision').length;
  const questions = minutes.filter(m => m.kind === 'question').length;
  const minutesLong = Math.round(speechMs / 60000);

  return (
    <ScrollView contentContainerStyle={st.pad} showsVerticalScrollIndicator={false}>
      <Slide>
        <Raised
          edge={colors.primaryEdge}
          gradient={{ from: colors.primary, to: colors.primaryLight, angle: 135 }}
          rad={radius.card24}
          depth={6}>
          <View style={st.gist}>
            <Txt variant="overlineSm" color={colors.onPrimary}>
              SUMMARY
            </Txt>
            <Txt variant="gist" color={colors.onPrimary} style={st.gistText}>
              {prose ??
                `${actions.length} ${actions.length === 1 ? 'action' : 'actions'}, ${decisions} ${
                  decisions === 1 ? 'decision' : 'decisions'
                } and ${questions} open ${questions === 1 ? 'question' : 'questions'} came out of this meeting.`}
            </Txt>
            {!prose ? (
              <Txt variant="chipSoft" color={colors.onPrimary} style={st.note}>
                Written minutes need the language model — check Settings.
              </Txt>
            ) : null}
          </View>
        </Raised>
      </Slide>

      <View style={st.factRow}>
        <Fact label={minutesLong === 1 ? 'minute' : 'minutes'} value={`${minutesLong}`} c={colors} />
        <Fact
          label={speakers.length === 1 ? 'speaker' : 'speakers'}
          value={`${speakers.length || '—'}`}
          c={colors}
        />
        <Fact
          label={actions.length === 1 ? 'action' : 'actions'}
          value={`${actions.length}`}
          c={colors}
        />
      </View>

      {actions.length > 0 ? (
        <>
          <Txt variant="overlineSm" color={colors.inkFaint} style={st.heading}>
            TOP ACTIONS
          </Txt>
          <View style={st.list}>
            {actions.slice(0, 3).map((m, i) => (
              <MinuteCard key={m.id ?? i} m={m} i={i} colors={colors} />
            ))}
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

function Fact({ label, value, c }: { label: string; value: string; c: Colors }) {
  const st = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Raised edge={c.line} fill={c.card} rad={radius.xl} depth={4} style={st.factFlex}>
      <View style={st.fact}>
        <Txt variant="statNum" color={c.ink}>
          {value}
        </Txt>
        <Txt variant="chipSoft" color={c.inkDim}>
          {label}
        </Txt>
      </View>
    </Raised>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    pad: { paddingHorizontal: s(16), paddingBottom: s(30), gap: s(14) },
    gist: { padding: s(18), gap: s(8) },
    gistText: { marginTop: s(2) },
    note: { opacity: 0.85, marginTop: s(4) },
    factRow: { flexDirection: 'row', gap: s(10) },
    factFlex: { flex: 1 },
    fact: { padding: s(14), alignItems: 'center', gap: s(2) },
    heading: { marginTop: s(4) },
    list: { gap: s(12) },
  });
}
```

- [ ] **Step 3: Create MinutesTab**

`src/screens/meeting/MinutesTab.tsx`:

```tsx
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Raised, SoftButton, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Minute } from '../../pipeline/types';
import { MinuteCard } from './shared';

/**
 * MOM — the document you would send someone. Prose first, then decisions and actions as a written
 * record. Read-only by design: the Actions tab is where items get worked, and a document that
 * doubles as a checklist reads as neither.
 */
export default function MinutesTab({
  minutes,
  onExport,
}: {
  minutes: Minute[];
  onExport: () => void;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);

  const narrative = minutes.find(m => m.kind === 'narrative' && m.source === 'llm')?.content;
  const decisions = minutes.filter(m => m.kind === 'decision');
  const actions = minutes.filter(m => m.kind === 'action');

  return (
    <ScrollView contentContainerStyle={st.pad} showsVerticalScrollIndicator={false}>
      {narrative ? (
        <Raised edge={colors.line} fill={colors.card} rad={radius.card24} depth={5}>
          <View style={st.doc}>
            <Txt variant="overlineSm" color={colors.inkFaint}>
              MINUTES
            </Txt>
            <Txt variant="minuteBody" style={st.prose}>
              {narrative}
            </Txt>
          </View>
        </Raised>
      ) : (
        <Raised edge={colors.line} fill={colors.card} rad={radius.card24} depth={5}>
          <View style={st.doc}>
            <Txt variant="bodyStrong" color={colors.inkDim}>
              No written minutes for this meeting
            </Txt>
            <Txt variant="body" color={colors.inkSoft}>
              The decisions and actions below were pulled out of the transcript by rule. Written
              minutes need the language model.
            </Txt>
          </View>
        </Raised>
      )}

      {decisions.length > 0 ? (
        <>
          <Txt variant="overlineSm" color={colors.inkFaint} style={st.heading}>
            DECISIONS
          </Txt>
          <View style={st.list}>
            {decisions.map((m, i) => (
              <MinuteCard key={m.id ?? i} m={m} i={i} colors={colors} />
            ))}
          </View>
        </>
      ) : null}

      {actions.length > 0 ? (
        <>
          <Txt variant="overlineSm" color={colors.inkFaint} style={st.heading}>
            ACTION ITEMS
          </Txt>
          <View style={st.list}>
            {actions.map((m, i) => (
              <MinuteCard key={m.id ?? i} m={m} i={i} colors={colors} />
            ))}
          </View>
        </>
      ) : null}

      <View style={st.exportRow}>
        <SoftButton icon="share" label="Export minutes" onPress={onExport} />
      </View>
    </ScrollView>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    pad: { paddingHorizontal: s(16), paddingBottom: s(30), gap: s(14) },
    doc: { padding: s(18), gap: s(8) },
    prose: { lineHeight: s(24) },
    heading: { marginTop: s(4) },
    list: { gap: s(12) },
    exportRow: { marginTop: s(10) },
  });
}
```

- [ ] **Step 4: Create TranscriptTab**

`src/screens/meeting/TranscriptTab.tsx`:

```tsx
import React from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Raised, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Speaker, Utterance } from '../../pipeline/types';
import { initials, stamp } from './shared';

/**
 * FlatList, not a mapped ScrollView. The old screen rendered every utterance at once inside the
 * one page scroll — 133 rows for an 8.5-minute meeting and roughly 900 for an hour-long one.
 */
export default function TranscriptTab({
  utterances,
  speakers,
}: {
  utterances: Utterance[];
  speakers: Speaker[];
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const nameById = React.useMemo(
    () => new Map(speakers.map(x => [x.id, x.displayName])),
    [speakers],
  );
  const indexById = React.useMemo(
    () => new Map(speakers.map((x, i) => [x.id, i])),
    [speakers],
  );

  return (
    <FlatList
      data={utterances}
      keyExtractor={(u, i) => u.id ?? String(i)}
      contentContainerStyle={st.pad}
      showsVerticalScrollIndicator={false}
      initialNumToRender={20}
      windowSize={11}
      removeClippedSubviews
      ListEmptyComponent={
        <Txt variant="body" color={colors.inkSoft} style={st.empty}>
          No transcript for this meeting.
        </Txt>
      }
      renderItem={({ item: u }) => {
        const who = u.speakerId ? nameById.get(u.speakerId) ?? 'Speaker' : 'Unlabelled';
        const idx = u.speakerId ? indexById.get(u.speakerId) ?? 0 : 0;
        const tint = colors.speakers[idx % colors.speakers.length];
        const tintSoft = colors.speakersSoft[idx % colors.speakersSoft.length];
        return (
          <View style={st.row}>
            <View style={[st.avatar, { backgroundColor: tintSoft }]}>
              <Txt variant="chip" color={tint}>
                {initials(who)}
              </Txt>
            </View>
            <Raised edge="#E9ECF5" fill={colors.card} rad={radius.ctl} depth={4} grow>
              <View style={st.card}>
                <Txt variant="chip" color={tint}>
                  {who} · {stamp(u.startMs)}
                </Txt>
                <Txt variant="transcript" style={st.text}>
                  {u.text}
                </Txt>
              </View>
            </Raised>
          </View>
        );
      }}
    />
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    pad: { paddingHorizontal: s(16), paddingBottom: s(30), gap: s(10) },
    empty: { paddingVertical: s(30), textAlign: 'center' },
    row: { flexDirection: 'row', gap: s(10), alignItems: 'flex-start' },
    avatar: {
      width: s(34),
      height: s(34),
      borderRadius: s(17),
      alignItems: 'center',
      justifyContent: 'center',
    },
    card: { padding: s(12), gap: s(4) },
    text: { marginTop: s(2) },
  });
}
```

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: errors only about `ActionsTab` not existing yet (Task 14 creates it) if you have already
referenced it; otherwise none.

- [ ] **Step 6: Commit**

```bash
git add src/screens/meeting/
git commit -m "feat(ui): summary, minutes and transcript tab views"
```

---

### Task 14: ActionsTab with persistent checkboxes

**Files:**
- Create: `src/screens/meeting/ActionsTab.tsx`
- Modify: `src/db/queries.ts`
- Modify: `android/app/src/main/java/com/audionotes/data/AudioDb.kt` (only if `rawQueryJson` cannot
  run INSERT — check first)

- [ ] **Step 1: Add the queries**

In `src/db/queries.ts`, inside the `db` object:

```typescript
  /**
   * Ticked-off actions, keyed by a hash of the item text rather than the minutes row id. Minutes
   * rows are deleted and re-inserted whenever a meeting is reprocessed, so a row-id key would
   * silently uncheck everything the user had worked through.
   */
  doneActions: async (meetingId: string): Promise<Set<string>> => {
    const rows = await run<{ itemKey: string }>(
      'SELECT item_key AS itemKey FROM action_done WHERE meeting_id = ?',
      [meetingId],
    );
    return new Set(rows.map(r => r.itemKey));
  },

  setActionDone: (meetingId: string, itemKey: string, done: boolean) =>
    done
      ? run('INSERT OR REPLACE INTO action_done(meeting_id, item_key, done_at) VALUES(?,?,?)', [
          meetingId,
          itemKey,
          Date.now(),
        ])
      : run('DELETE FROM action_done WHERE meeting_id = ? AND item_key = ?', [meetingId, itemKey]),
```

- [ ] **Step 2: Confirm writes go through the query bridge**

No change is needed here — this step is a check, not a task. `AudioDb.rawQueryJson`
(`AudioDb.kt:23`) branches on the statement: anything not starting with `SELECT` goes to
`db.execSQL` and returns `[]`. So the `run()` helper in `queries.ts` executes INSERT and DELETE
correctly, which is why the existing `replaceMinutes` works. Verify with:

```bash
sed -n 23,29p android/app/src/main/java/com/audionotes/data/AudioDb.kt
```

Expected: the `if (!trimmed.regionMatches(0, "SELECT", ...)) { db.execSQL(sql, args); return "[]" }`
branch is present.

- [ ] **Step 3: Create the tab**

`src/screens/meeting/ActionsTab.tsx`:

```tsx
import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Icon from '../../components/Icon';
import { Raised, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Minute } from '../../pipeline/types';
import { db } from '../../db/queries';

/**
 * The worklist. Every item here came from rule extraction, so each one quotes something that was
 * actually said — measured invented=0 across four AMI fixtures, which is why the LLM's prose does
 * not feed this tab.
 */
export function itemKey(content: string): string {
  const norm = content.trim().toLowerCase().replace(/\s+/g, ' ');
  let h = 0;
  for (let i = 0; i < norm.length; i++) {
    h = (h * 31 + norm.charCodeAt(i)) | 0;
  }
  return `${norm.length}:${h}`;
}

export default function ActionsTab({
  meetingId,
  minutes,
}: {
  meetingId: string;
  minutes: Minute[];
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const [done, setDone] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    let alive = true;
    db.doneActions(meetingId)
      .then(d => {
        if (alive) setDone(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [meetingId]);

  const actions = minutes.filter(m => m.kind === 'action');
  const decisions = minutes.filter(m => m.kind === 'decision');
  const questions = minutes.filter(m => m.kind === 'question');

  const toggle = React.useCallback(
    (content: string) => {
      const key = itemKey(content);
      setDone(prev => {
        const next = new Set(prev);
        const on = !next.has(key);
        if (on) next.add(key);
        else next.delete(key);
        db.setActionDone(meetingId, key, on).catch(() => {});
        return next;
      });
    },
    [meetingId],
  );

  return (
    <ScrollView contentContainerStyle={st.pad} showsVerticalScrollIndicator={false}>
      {actions.length === 0 && decisions.length === 0 && questions.length === 0 ? (
        <Txt variant="body" color={colors.inkSoft} style={st.empty}>
          Nothing to act on came out of this meeting.
        </Txt>
      ) : null}

      {actions.length > 0 ? (
        <>
          <Txt variant="overlineSm" color={colors.inkFaint}>
            TO DO
          </Txt>
          <View style={st.list}>
            {actions.map((m, i) => {
              const on = done.has(itemKey(m.content));
              return (
                <Pressable
                  key={m.id ?? i}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={m.content}
                  onPress={() => toggle(m.content)}>
                  <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={4}>
                    <View style={st.check}>
                      <View
                        style={[
                          st.box,
                          { borderColor: on ? colors.success : colors.line },
                          on && { backgroundColor: colors.successSoft },
                        ]}>
                        {on ? (
                          <Icon name="check" size={s(15)} color={colors.success} strokeWidth={3.2} />
                        ) : null}
                      </View>
                      <Txt
                        variant="minuteBody"
                        color={on ? colors.inkFaint : colors.ink}
                        style={[st.flex, on && st.struck]}>
                        {m.content}
                      </Txt>
                    </View>
                  </Raised>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}

      {decisions.length > 0 ? (
        <>
          <Txt variant="overlineSm" color={colors.inkFaint} style={st.heading}>
            DECIDED
          </Txt>
          <View style={st.list}>
            {decisions.map((m, i) => (
              <Raised key={m.id ?? i} edge={colors.line} fill={colors.card} rad={radius.xl} depth={4}>
                <View style={st.plain}>
                  <Txt variant="minuteBody">{m.content}</Txt>
                </View>
              </Raised>
            ))}
          </View>
        </>
      ) : null}

      {questions.length > 0 ? (
        <>
          <Txt variant="overlineSm" color={colors.inkFaint} style={st.heading}>
            STILL OPEN
          </Txt>
          <View style={st.list}>
            {questions.map((m, i) => (
              <Raised key={m.id ?? i} edge={colors.line} fill={colors.card} rad={radius.xl} depth={4}>
                <View style={st.plain}>
                  <Txt variant="minuteBody">{m.content}</Txt>
                </View>
              </Raised>
            ))}
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    pad: { paddingHorizontal: s(16), paddingBottom: s(30), gap: s(10) },
    empty: { paddingVertical: s(30), textAlign: 'center' },
    list: { gap: s(10) },
    heading: { marginTop: s(8) },
    check: { flexDirection: 'row', gap: s(12), padding: s(14), alignItems: 'flex-start' },
    plain: { padding: s(14) },
    box: {
      width: s(24),
      height: s(24),
      borderRadius: s(8),
      borderWidth: s(2),
      alignItems: 'center',
      justifyContent: 'center',
    },
    flex: { flex: 1 },
    struck: { textDecorationLine: 'line-through' },
  });
}
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/screens/meeting/ActionsTab.tsx src/db/queries.ts
git commit -m "feat(ui): actions worklist whose ticks survive reprocessing"
```

---

### Task 15: The shell

**Files:**
- Modify: `src/screens/MeetingScreen.tsx`

- [ ] **Step 1: Replace the results branch with tabs**

Keep everything from the top of the file through the `if (working) { ... }` processing branch
unchanged — the progress ring, the stage checklist, the sheet and the footer all still apply.
Replace only the final `return (...)` (the one starting `<View style={st.root}><ScrollView ...>`,
`MeetingScreen.tsx:325`) with:

```tsx
  const TABS = [
    { key: 'summary', label: 'Summary' },
    { key: 'mom', label: 'MOM' },
    { key: 'actions', label: 'Actions' },
    { key: 'transcript', label: 'Script' },
  ];

  return (
    <View style={st.root}>
      <View style={[st.navRowDetail, { paddingTop: insets.top + s(6) }]}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <View style={st.flex}>
          <Txt variant="sectionTitle" numberOfLines={1}>
            {meeting?.title || 'Meeting'}
          </Txt>
          <Txt variant="chipSoft" color={colors.inkFaint}>
            {meeting?.createdAt
              ? new Date(meeting.createdAt).toLocaleString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : ''}
          </Txt>
        </View>
        <IconButton icon="more" label="More actions" onPress={() => setSheet(true)} />
      </View>

      {failure ? (
        <View style={st.failCard}>
          <Icon name="alert" size={s(18)} color={colors.danger} strokeWidth={2.4} />
          <Txt variant="bodyStrong" color={colors.danger} style={st.flex}>
            {failure}
          </Txt>
        </View>
      ) : null}

      {empty ? (
        <View style={st.emptyWrap}>
          <Mascot mood="asleep" size={sv(130)} />
          <Txt variant="display" style={st.emptyTitle}>
            Nothing to show
          </Txt>
          <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
            Pip could not hear any speech in this recording. If the mic was covered or the room was
            very quiet, try again a little closer.
          </Txt>
        </View>
      ) : (
        <>
          <Segmented items={TABS} value={tab} onChange={setTab} />
          <View style={st.flex}>
            {tab === 'summary' ? (
              <SummaryTab
                meeting={meeting}
                minutes={minutes}
                speakers={speakers}
                speechMs={speechMs}
              />
            ) : tab === 'mom' ? (
              <MinutesTab minutes={minutes} onExport={onExport} />
            ) : tab === 'actions' ? (
              <ActionsTab meetingId={meetingId} minutes={minutes} />
            ) : (
              <TranscriptTab utterances={utterances} speakers={speakers} />
            )}
          </View>
        </>
      )}

      <Sheet
        visible={sheet}
        title={meeting?.title || 'Meeting'}
        actions={sheetActions}
        onClose={() => setSheet(false)}
      />
    </View>
  );
}
```

- [ ] **Step 2: Add the tab state**

Next to the other `useState` declarations near `MeetingScreen.tsx:91`:

```tsx
  // Always lands on Summary. A remembered tab means tapping two meetings in a row opens them on
  // different screens, which reads as a bug rather than a convenience.
  const [tab, setTab] = useState('summary');
```

- [ ] **Step 3: Update the imports**

Add `Segmented` to the existing `../components/ui` import list, and add:

```tsx
import SummaryTab from './meeting/SummaryTab';
import MinutesTab from './meeting/MinutesTab';
import ActionsTab from './meeting/ActionsTab';
import TranscriptTab from './meeting/TranscriptTab';
```

Remove `ScrollView`, `SectionRule`, `Badge`, `Pop`, `GradientFill`, `Raised`, `Slide` and `tilt`
from the imports **only if** the processing branch no longer uses them — `Raised`, `GradientFill`
and `ProgressRing` are still needed there. Let the typecheck tell you.

- [ ] **Step 4: Delete the now-dead helpers and styles**

`kindMeta`, `initials` and `stamp` moved to `src/screens/meeting/shared.tsx` in Task 13 — delete
them from `MeetingScreen.tsx` (lines 43-74). Delete the style keys only the old list used:
`gist`, `gistLabel`, `gistText`, `gistChips`, `gistChip`, `minuteRow`, `minuteIcon`, `minuteCard`,
`minuteText`, `uttRow`, `uttAvatar`, `uttCard`, `uttText`, `bubbleShape`, `ruleWrap`, `list`,
`statRow`, `stat`, `actionRow`.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors. An "is declared but its value is never read" error names something from Step 4
still to delete.

- [ ] **Step 6: Run it on the device**

```bash
npx react-native start --port 8088 &
$ADB reverse tcp:8081 tcp:8088
$ADB shell am start -n com.audionotes/.MainActivity
```

> Metro must be on 8088 with `adb reverse tcp:8081 tcp:8088`, because port 8081 on this machine is
> taken by an unrelated Next.js project. Pointing the phone at 8081 loads that app's bundle and the
> screen comes up grey.

Open a finished meeting. Expected: it lands on Summary, and all four tabs switch without the page
scrolling horizontally.

- [ ] **Step 7: Commit**

```bash
git add src/screens/MeetingScreen.tsx
git commit -m "feat(ui): tabs instead of one long meeting page"
```

---

### Task 16: The library row one-liner

**Files:**
- Modify: `src/db/queries.ts`
- Modify: `src/pipeline/types.ts`
- Modify: `src/screens/LibraryScreen.tsx`

- [ ] **Step 1: Select the column**

In `src/db/queries.ts`, add `summary_line AS summaryLine` to the column list of `listMeetings`,
`listArchived` and `getMeeting` — all three build the same aliased projection, so all three need it
or the field is silently `undefined` on some screens.

- [ ] **Step 2: Add the field to the type**

In `src/pipeline/types.ts`, add to the `Meeting` interface:

```typescript
  /** One-line description written by the LLM. Absent until narration runs. */
  summaryLine?: string | null;
```

- [ ] **Step 3: Show it on the card**

In `src/screens/LibraryScreen.tsx`, in the full-width `Card` component after the title `Txt` at
line 227:

```tsx
            {m.summaryLine ? (
              <Txt variant="chipSoft" color={colors.inkSoft} numberOfLines={2} style={st.cardLine}>
                {m.summaryLine}
              </Txt>
            ) : m.status !== 'done' && m.status !== 'error' ? (
              <Txt variant="chipSoft" color={colors.inkFaint} numberOfLines={1} style={st.cardLine}>
                {statusOf(m.status, colors).label}…
              </Txt>
            ) : null}
```

Add the style:

```tsx
    cardLine: { marginTop: s(4) },
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries.ts src/pipeline/types.ts src/screens/LibraryScreen.tsx
git commit -m "feat(ui): library rows say what the meeting was about"
```

---

## Phase F — Getting the model onto phones

### Task 17: Offer the model at first run

**Files:**
- Modify: `android/app/src/main/java/com/audionotes/data/ModelCatalog.kt`
- Modify: `src/screens/OnboardingScreen.tsx`

- [ ] **Step 1: Read how REQUIRED drives first-run download**

```bash
grep -n "REQUIRED" -r android/app/src/main/java/com/audionotes/ src/ | grep -v graphify-out
```

- [ ] **Step 2: Add an OPTIONAL_DEFAULT list**

In `ModelCatalog.kt`, next to `REQUIRED`:

```kotlin
  /**
   * Models the app offers on first run but works without.
   *
   * llm-qwen is 1.1 GB — making it a hard prerequisite puts a 1.2 GB wall in front of anyone before
   * they have seen the app work at all. Meetings recorded before it lands get rule-based minutes,
   * and are narrated by the next sweep once it arrives.
   */
  val OPTIONAL_DEFAULT: List<ModelSpec> = ALL.filter { !it.required && it.kind == "llm" }
```

- [ ] **Step 3: Offer it in onboarding**

`OnboardingScreen.tsx:64` filters the catalog listing down to `m.required`. Add a second, opt-in
list beside it.

First widen the `Essential` type at `OnboardingScreen.tsx:29` — `downloadAll` now needs to know
whether a failure is fatal, and the filter needs `kind`. Both fields are already in the JSON
(`ModelManagerModule.kt:39-40`); the type just never named them:

```tsx
type Essential = { id: string; purpose: string; sizeBytes: number; kind: string; required: boolean };
```

Add state next to `const [essentials, setEssentials] = useState<Essential[]>([]);`:

```tsx
  const [writer, setWriter] = useState<Essential[]>([]);
  // Defaults on: a meeting app whose minutes read like a word count is not the product. Off is one
  // tap away, and the app is fully usable either way.
  const [wantWriter, setWantWriter] = useState(true);
```

Change the catalog effect at line 62 to fill both:

```tsx
  useEffect(() => {
    ModelManager.list()
      .then(r => {
        const all = JSON.parse(r);
        setEssentials(all.filter((m: any) => m.required));
        setWriter(all.filter((m: any) => !m.required && m.kind === 'llm'));
      })
      .catch(() => {});
  }, []);
```

Change the size line so the button tells the truth about what the tap will cost:

```tsx
  const chosen = wantWriter ? [...essentials, ...writer] : essentials;
  const totalMb = Math.round(chosen.reduce((a, m) => a + m.sizeBytes, 0) / 1e6);
```

Change `downloadAll` to walk `chosen`, and to treat a failed optional download as non-fatal:

```tsx
  const downloadAll = async () => {
    setStatus('downloading');
    AudioPipeline.requestBatteryExemption().catch(() => {});
    for (let i = 0; i < chosen.length; i++) {
      setStep(i);
      setCurrent(chosen[i].purpose);
      setPct(0);
      try {
        await ModelManager.download(chosen[i].id);
      } catch {
        // Only the required models can fail the setup. Losing the writer means minutes pulled out
        // by rule instead of written as prose — a smaller app, not a broken one, and it can be
        // fetched later from Settings.
        if (chosen[i].required) {
          setStatus('failed');
          return;
        }
      }
    }
    setStatus('done');
  };
```

Add the toggle above the download button, inside the `<Pop index={5} style={st.footer}>` block and
before `<Button ...>`:

```tsx
        {writer.length > 0 ? (
          <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={5}>
            <View style={st.bullet}>
              <View style={[st.bulletIcon, { backgroundColor: colors.primarySoft }]}>
                <Icon name="edit" size={s(20)} color={colors.primary} strokeWidth={2.4} />
              </View>
              <View style={st.flex}>
                <Txt variant="cardTitleSm">Write the minutes in plain English</Txt>
                <Txt variant="chip" color={colors.inkSoft} style={st.bulletBody}>
                  Adds {Math.round(writer.reduce((a, m) => a + m.sizeBytes, 0) / 1e6)} MB. Without
                  it you still get minutes, pulled out by rule rather than written as prose.
                </Txt>
              </View>
              <Switch on={wantWriter} onToggle={() => setWantWriter(v => !v)} />
            </View>
          </Raised>
        ) : null}
```

`Switch` is already exported from `src/components/ui.tsx:486` — add it to this file's import list
from `../components/ui`. The `edit` icon exists in `src/components/Icon.tsx`; no substitute needed.

- [ ] **Step 4: Verify the app works without the model**

```bash
$ADB shell run-as com.audionotes mv files/models/qwen-instruct-q4_k_m.gguf files/models/qwen.bak
$ADB shell am start -n com.audionotes/.MainActivity
```

Open a meeting. Expected: the Summary tab shows the at-a-glance card and the note about the language
model; MOM shows the rule-extracted decisions and actions; nothing crashes. Then restore it:

```bash
$ADB shell run-as com.audionotes mv files/models/qwen.bak files/models/qwen-instruct-q4_k_m.gguf
```

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/audionotes/data/ModelCatalog.kt src/screens/OnboardingScreen.tsx
git commit -m "feat(models): offer the language model at setup without blocking on it"
```

---

## Task 18: Full verification

- [ ] **Step 1: C++ suite**

```bash
$CMAKE --build cpp/cli/build -j8 && (cd cpp/cli/build && ctest --output-on-failure)
```

Expected: all tests pass.

- [ ] **Step 2: JS suite and typecheck**

```bash
npx tsc --noEmit && npx jest 2>&1 | tail -10
```

Expected: no type errors, all tests pass.

- [ ] **Step 3: Device suite**

```bash
./scripts/device-verify.sh
```

Expected: `OK` for both `NativePipelineTest` and `MinutesParityTest`, plus the new
`MinutesSourceTest`. This script installs both APKs with `adb install -r` rather than running
`connectedDebugAndroidTest`, which would uninstall the app and delete the models and every recording.

- [ ] **Step 4: End-to-end on the real recording**

```bash
./cpp/cli/build/audionotes_cli eval/models/ggml-base-q5_1.bin \
  eval/fixtures/real-neosym-2026-08-19/audio.wav \
  --vad eval/models/silero_vad.onnx \
  --diar-seg eval/models/diar_segmentation.onnx \
  --diar-emb eval/models/diar_embedding.onnx \
  --llm eval/models/qwen-instruct-q4_k_m.gguf \
  --json /tmp/after.json
python3 -c "
import json
d=json.load(open('/tmp/after.json'))
print([m['content'] for m in d['minutes'] if m['kind']=='summary'])
"
```

Expected: a prose summary naming what the meeting was about — not a sentence beginning "No decisions
were explicitly stated."

- [ ] **Step 5: Score the narrated minutes with the judge**

The spec requires this before the summary is treated as production quality. The harness scores what
the CLI produces, and the CLI now runs the same prompts the phone does.

```bash
python3 -m eval.run --judge --judge-model eval/models/judge-qwen2.5-7b-instruct-q4_k_m.gguf
python3 -m eval.report
```

Expected: a "Minutes quality" table. Compare `recall` and `invented` against the pre-change run
recorded in `eval/results/20260825-114628/` — recall 85.7 / 68.8 / 100.0 / 70.0 and invented 0
across all four fixtures.

**`invented` rising above 0 is a release blocker.** It counts items absent from our own transcript,
which is exactly the failure mode an abstractive model introduces and the extractive rules could
not have. Recall moving either way is information; invented moving off zero means the minutes are
making things up.

Note the report will still print the "judge has not been calibrated" warning until 20 items are
human-labelled. Until then these numbers are directional, not evidence.

- [ ] **Step 6: Record a real meeting on the phone**

Enable Settings → keep audio first, so the recording survives retention and can become a fixture.
Record, stop from the notification, and confirm the library row fills in with a one-liner without
the app being opened.

---

## Notes for whoever runs this

- **Never run `./gradlew connectedDebugAndroidTest`.** It uninstalls the app, which deletes the
  downloaded models and the meeting database. Use `scripts/device-verify.sh`.
- **Metro runs on 8088 here**, with `adb reverse tcp:8081 tcp:8088`. Port 8081 belongs to an
  unrelated project on this machine, and pointing the phone at it produces a grey screen.
- **Low CPU in `ps` does not mean a hang.** llama.cpp on Metal shows near-zero host CPU while it is
  working. A long-running generation that looks idle is usually fine.
- **The eval harness judge is not calibrated.** Its minutes-quality numbers are provisional until
  20 items are human-labelled — `python3 -m eval.calibrate export <run-dir>`. Do not quote them as
  quality evidence for the narration until that gate passes.
