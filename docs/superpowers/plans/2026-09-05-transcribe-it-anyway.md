# Transcribe It Anyway — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a meeting wrongly refused as "NOT ENGLISH" a way back — one override action that transcribes it anyway, and never lets the result pretend it was not overridden.

**Architecture:** A per-meeting flag (`transcribe_forced_at`) plus the language that was heard (`forced_from_language`) travel from the refused screen down through Kotlin and JNI to a single `bool skip_language_refusal` on `AsrConfig`, which guards only the `shouldRefuse` branch in `whisper_asr.cpp`. Detection still runs, so the result can always say what was heard. The same two columns drive a non-dismissible in-app banner and a marker prepended to every export format.

**Tech Stack:** C++17 (core, built with the NDK and with the desktop CMake CLI), Kotlin (Android, React Native New Architecture TurboModules), TypeScript/React Native 0.86, SQLCipher.

**Spec:** `docs/superpowers/specs/2026-09-05-transcribe-it-anyway-design.md`

---

## Build and test commands

Used throughout. `cmake` and `adb` are not on PATH on this machine.

```bash
CMAKE=/Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake
export ANDROID_HOME=/Users/akshayghosh/Android/Library/SDK
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home
export PATH=$ANDROID_HOME/platform-tools:$PATH

# C++ core + its tests (desktop)
cd cpp/cli/build && $CMAKE --build . && $CMAKE -E chdir . ctest --output-on-failure

# Kotlin unit tests (JVM, no device)
cd android && ./gradlew :app:testDebugUnitTest

# TypeScript
npm test && npm run lint

# On-device native suite — NEVER `./gradlew connectedDebugAndroidTest`, it uninstalls the
# app and wipes the models and the recordings database.
npm run test:device
```

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `cpp/asr/asr_engine.h` | `AsrConfig` | Add `skip_language_refusal` |
| `cpp/asr/whisper_asr.h` / `.cpp` | The only engine that refuses | Accept and honour the flag |
| `cpp/asr/asr_factory.cpp` | Config → engine | Pass the flag to `WhisperAsr` |
| `cpp/tests/test_asr_languages.cpp` | Refusal-decision tests | Cover the bypass |
| `cpp/jni/audionotes_jni.cpp` | JNI boundary | New `forceLanguage` parameter |
| `cpp/cli/main.cpp` | Desktop CLI | `--force-language` so the flag is exercisable without a phone |
| `android/.../data/AudioDb.kt` | Schema + reader | Two columns, one reader (the write is TypeScript) |
| `android/.../pipeline/NativeBridge.kt` | `external fun` declaration | New parameter |
| `android/.../pipeline/ProcessingEngine.kt` | Orchestration | Read the flag, pass it, preserve the heard language |
| `android/.../pipeline/FileExportModule.kt` | Every export format | Prepend the marker |
| `android/app/src/test/.../ForcedTranscriptTest.kt` | New | Columns and export marker |
| `src/db/schema.ts` | Readable schema copy | Two columns |
| `src/db/queries.ts` | Meeting selects | Two fields |
| `src/pipeline/types.ts` | `Meeting` | Two fields |
| `src/screens/languages.ts` | Refusal copy | Confirm + banner copy |
| `src/screens/MeetingScreen.tsx` | Refused screen | Action, confirm, banner |
| `src/screens/__tests__/languages.test.ts` | Copy tests | New cases |

---

## Task 1: The C++ flag

**Files:**
- Modify: `cpp/asr/asr_engine.h`
- Modify: `cpp/asr/whisper_asr.h`, `cpp/asr/whisper_asr.cpp`
- Modify: `cpp/asr/asr_factory.cpp`
- Test: `cpp/tests/test_asr_languages.cpp`

- [ ] **Step 1: Write the failing test**

Append inside `main()` in `cpp/tests/test_asr_languages.cpp`, just before the `return failures ? 1 : 0;` line. Add `#include "asr/asr_engine.h"` to the includes at the top if it is not already there.

```cpp
  // ---- the override ----
  //
  // A wrong refusal used to be unrecoverable: Redo re-runs the same detection and reaches the same
  // verdict. The flag exists so a person who knows the recording was English can overrule it.
  //
  // Asserted against shouldRefuse rather than a whole transcribe() run because the decision is
  // pure and the run needs 60 MB of weights. What this pins is that the flag changes the DECISION
  // and nothing else — a bypass that also skipped detection could not tell anyone what was heard.
  {
    audionotes::LanguageVerdict turkish;
    turkish.code = "tr";
    turkish.mean_p = 0.95f;
    turkish.votes = 4;
    turkish.samples = 5;
    CHECK(audionotes::shouldRefuse(turkish, 0.7f),
          "a confident majority for an unsupported language must still refuse by default");

    audionotes::AsrConfig cfg;
    CHECK(!cfg.skip_language_refusal, "the override must be off unless somebody asks for it");
  }
```

- [ ] **Step 2: Run it and watch it fail**

```bash
CMAKE=/Users/akshayghosh/Android/Library/SDK/cmake/3.22.1/bin/cmake
cd cpp/cli/build && $CMAKE --build . 2>&1 | tail -20
```

Expected: compile error — `no member named 'skip_language_refusal' in 'audionotes::AsrConfig'`.

- [ ] **Step 3: Add the field to `AsrConfig`**

In `cpp/asr/asr_engine.h`, inside `struct AsrConfig`, after `sherpa_model_dir`:

```cpp
  // Overrule the language refusal for ONE run, because a person said the recording really is in
  // the language they asked for.
  //
  // Not a setting and not a policy: refusing is what stops an hour of Bengali coming back as
  // confident invented English, and a build that could switch that off globally would not have
  // the guarantee at all. This is per-run recovery from a detector that was wrong, which the
  // Galaxy A07 recording proved is possible — English heard as Turkish at p=0.88.
  bool skip_language_refusal = false;
```

- [ ] **Step 4: Honour it in `WhisperAsr`**

In `cpp/asr/whisper_asr.h`, change the constructor declaration:

```cpp
  explicit WhisperAsr(const std::string& model_path, const std::string& language = "en",
                      bool skip_language_refusal = false);
```

In `cpp/asr/whisper_asr.cpp`, find the `WhisperAsr::WhisperAsr` definition and the `Impl` struct. Add a `bool skip_refusal = false;` member to `Impl`, set it from the new constructor argument, and change the refusal branch (currently `if (shouldRefuse(heard, kRefuseConfidence)) {`) to:

```cpp
    // The override guards ONLY this branch. Detection above still runs and still populates
    // run.detected_language / run.detected_confidence, which is what lets a forced transcript say
    // "we heard Turkish and you overruled us" rather than only "you forced this". The cost is a
    // handful of encoder passes that every run already pays.
    if (!impl_->skip_refusal && shouldRefuse(heard, kRefuseConfidence)) {
```

- [ ] **Step 5: Pass it through the factory**

In `cpp/asr/asr_factory.cpp`, the final `return` currently reads:

```cpp
  return std::unique_ptr<AsrEngine>(new WhisperAsr(cfg.whisper_model, cfg.language));
```

Change it to:

```cpp
  return std::unique_ptr<AsrEngine>(
      new WhisperAsr(cfg.whisper_model, cfg.language, cfg.skip_language_refusal));
```

- [ ] **Step 6: Build and run the tests**

```bash
cd cpp/cli/build && $CMAKE --build . && ctest --output-on-failure 2>&1 | tail -6
```

Expected: `100% tests passed, 0 tests failed out of 11`.

- [ ] **Step 7: Commit**

```bash
git add cpp/asr/asr_engine.h cpp/asr/whisper_asr.h cpp/asr/whisper_asr.cpp \
        cpp/asr/asr_factory.cpp cpp/tests/test_asr_languages.cpp
git commit -m "feat(asr): let one run overrule the language refusal

Guards only the shouldRefuse branch. Detection still runs, so a forced transcript can still say
what was heard — a bypass that skipped detection could only say that it was forced."
```

---

## Task 2: The CLI flag, so this is testable without a phone

**Files:**
- Modify: `cpp/cli/main.cpp`

- [ ] **Step 1: Add the flag to the usage text**

In `cpp/cli/main.cpp`, change the line:

```cpp
                 "          [--qwen3-model DIR] [--sherpa-model DIR]\n"
```

to:

```cpp
                 "          [--qwen3-model DIR] [--sherpa-model DIR] [--force-language]\n"
```

- [ ] **Step 2: Parse it**

Find `std::string asr_engine, qwen3_model, sherpa_model;` and add below it:

```cpp
  bool force_language = false;
```

Find the `--sherpa-model` parse line and add after it:

```cpp
    else if (std::strcmp(argv[i], "--force-language") == 0) force_language = true;
```

- [ ] **Step 3: Wire it into the config**

Find `cfg.sherpa_model_dir = sherpa_model;` and add below it:

```cpp
  // The desktop mirror of "Transcribe it anyway". Present so the override can be exercised
  // against a real recording without a phone in the loop.
  cfg.skip_language_refusal = force_language;
```

- [ ] **Step 4: Add the field to `PipelineConfig` and thread it**

In `cpp/pipeline/pipeline.h`, in `struct PipelineConfig`, after `sherpa_model_dir`:

```cpp
  // Overrule the language refusal for this run. See AsrConfig::skip_language_refusal.
  bool skip_language_refusal = false;
```

In `cpp/pipeline/pipeline.cpp`, find `acfg.sherpa_model_dir = cfg_.sherpa_model_dir;` and add below it:

```cpp
    acfg.skip_language_refusal = cfg_.skip_language_refusal;
```

- [ ] **Step 5: Build and verify the flag reaches the decision**

```bash
cd cpp/cli/build && $CMAKE --build . 2>&1 | grep -iE '^FAILED|error:' ; echo "build ok"
cd /Users/akshayghosh/ReactNative/InnoCoreLabs/AudioNotes
./cpp/cli/build/audionotes_cli 2>&1 | grep force-language
```

Expected: the usage line containing `[--force-language]` prints.

- [ ] **Step 6: Run the full test suite**

```bash
cd cpp/cli/build && ctest --output-on-failure 2>&1 | tail -4
```

Expected: `100% tests passed, 0 tests failed out of 11`.

- [ ] **Step 7: Commit**

```bash
git add cpp/cli/main.cpp cpp/pipeline/pipeline.h cpp/pipeline/pipeline.cpp
git commit -m "feat(cli): --force-language, so the override is exercisable without a phone"
```

---

## Task 3: The JNI parameter

**Files:**
- Modify: `cpp/jni/audionotes_jni.cpp`
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/NativeBridge.kt`

Note: this changes a JNI signature. `0fb96e8` is a live reminder that device tests calling this go stale silently, so Task 7 re-runs them.

- [ ] **Step 1: Add the parameter to the C++ side**

In `cpp/jni/audionotes_jni.cpp`, change the `nativeTranscribe` signature:

```cpp
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeTranscribe(
    JNIEnv* env, jobject /*thiz*/, jstring jPcmPath, jstring jModelPath, jint sampleRate,
    jlongArray jStarts, jlongArray jEnds, jint threads, jstring jLanguage,
    jstring jQwen3Dir, jboolean jForceLanguage) {
```

Find `acfg.qwen3_model_dir = qwen3_dir;` and add below it:

```cpp
    // Set only by "Transcribe it anyway" on a meeting this build already refused once.
    acfg.skip_language_refusal = (jForceLanguage == JNI_TRUE);
```

- [ ] **Step 2: Add the parameter to the Kotlin declaration**

In `NativeBridge.kt`, change the `external fun nativeTranscribe` declaration:

```kotlin
  external fun nativeTranscribe(
    pcmPath: String,
    modelPath: String,
    sampleRate: Int,
    segStarts: LongArray,
    segEnds: LongArray,
    threads: Int = 0,
    language: String = "en",
    qwen3ModelDir: String = "",
    forceLanguage: Boolean = false,
  ): String
```

- [ ] **Step 3: Update the existing call site so the app still compiles**

In `ProcessingEngine.kt`, the call currently ends `if (qwen3Dir.isDirectory) qwen3Dir.absolutePath else "",`. Leave it for now — the Kotlin default (`false`) keeps it valid. Task 5 replaces it.

- [ ] **Step 4: Build the app to check the signature matches**

```bash
export ANDROID_HOME=/Users/akshayghosh/Android/Library/SDK
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home
cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a \
  -PAUDIONOTES_DEBUG_UPLOAD_SIGNING 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 5: Commit**

```bash
git add cpp/jni/audionotes_jni.cpp android/app/src/main/java/com/innocorelabs/verbale/pipeline/NativeBridge.kt
git commit -m "feat(jni): carry the language-refusal override across the boundary"
```

---

## Task 4: The two columns

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt`
- Modify: `src/db/schema.ts`
- Test: `android/app/src/test/java/com/innocorelabs/verbale/ForcedTranscriptTest.kt` (create)

- [ ] **Step 1: Write the failing test**

Create `android/app/src/test/java/com/innocorelabs/verbale/ForcedTranscriptTest.kt`:

```kotlin
package com.innocorelabs.verbale

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The two columns behind "Transcribe it anyway", checked without a device.
 *
 * `forced_from_language` is the one that fails silently: ProcessingEngine sets `language` to what
 * was HEARD on the refusal path and to what was REQUESTED on success, so a forced run overwrites
 * the heard code with "en" and the banner loses its claim. Nothing breaks — the banner just goes
 * quiet, which is the failure this pins.
 */
class ForcedTranscriptTest {

  @Test
  fun forced_columns_are_declared_in_the_migration_list() {
    val added = com.innocorelabs.verbale.data.AudioDb.addedColumnsForTest()
    assertEquals(
      "INTEGER",
      added.firstOrNull { it.first == "meetings" && it.second == "transcribe_forced_at" }?.third,
    )
    assertEquals(
      "TEXT",
      added.firstOrNull { it.first == "meetings" && it.second == "forced_from_language" }?.third,
    )
  }

  @Test
  fun a_meeting_that_was_never_forced_has_no_marker() {
    assertNull(forcedBannerLanguage(transcribeForcedAt = null, forcedFromLanguage = "tr"))
  }

  @Test
  fun a_forced_meeting_reports_the_language_it_was_forced_from() {
    assertEquals("tr", forcedBannerLanguage(transcribeForcedAt = 1_725_000_000_000L,
                                            forcedFromLanguage = "tr"))
  }

  @Test
  fun a_forced_meeting_with_no_heard_language_still_reports_that_it_was_forced() {
    assertEquals("", forcedBannerLanguage(transcribeForcedAt = 1_725_000_000_000L,
                                          forcedFromLanguage = null))
  }
}

/**
 * Null when the meeting was never forced; otherwise the language code it was forced from, or ""
 * when detection never named one. Kept as a free function so the rule is testable without opening
 * a database.
 */
fun forcedBannerLanguage(transcribeForcedAt: Long?, forcedFromLanguage: String?): String? =
  if (transcribeForcedAt == null) null else (forcedFromLanguage ?: "")
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests '*ForcedTranscriptTest*' 2>&1 | tail -15
```

Expected: compile error — `addedColumnsForTest` is unresolved.

- [ ] **Step 3: Add the columns and the test accessor**

In `AudioDb.kt`, inside the `ADDED_COLUMNS` list, after the `title_edited_at` entry:

```kotlin
      // "Transcribe it anyway": a person overruled the language refusal on this meeting. The
      // timestamp is both the REQUEST (ProcessingEngine reads it to bypass the check) and the
      // RECORD (the banner and every export read it forever). One column, because a transient
      // flag plus a separate marker can disagree — a forced run that crashes would leave a marker
      // with no transcript, or invented text with no marker.
      Triple("meetings", "transcribe_forced_at", "INTEGER"),
      // What was HEARD before the override, captured because the forced run destroys it: the
      // refusal path writes the heard code into `language`, the success path overwrites it with
      // the requested one. Without this the banner cannot say "heard as Turkish" an hour later.
      Triple("meetings", "forced_from_language", "TEXT"),
```

Then, in the same `companion object` that holds `ADDED_COLUMNS`, add:

```kotlin
    /** The migration list, for a unit test that must not open an encrypted database. */
    @JvmStatic
    fun addedColumnsForTest(): List<Triple<String, String, String>> = ADDED_COLUMNS
```

- [ ] **Step 4: Add the accessors**

In `AudioDb.kt`, after `fun setLanguage(...)`. Only a READER is added here — the write happens in
TypeScript (Task 8), because forcing is always a tap in the app and `src/db/queries.ts` already
writes this database directly through `Storage.query`, the same way `clearNarration` does. A second
writer in Kotlin would be a second place for the same rule to live.

```kotlin
  /** Null when this meeting was never forced. Written by src/db/queries.ts markTranscribeForced. */
  fun transcribeForcedAt(id: String): Long? {
    db.rawQuery("SELECT transcribe_forced_at FROM meetings WHERE id=?", arrayOf(id)).use { c ->
      if (!c.moveToFirst() || c.isNull(0)) return null
      return c.getLong(0)
    }
  }
```

- [ ] **Step 5: Mirror the columns in the readable TypeScript schema**

In `src/db/schema.ts`, change the `meetings` table's last column line from:

```
     summary_line TEXT             -- one-line description written by the LLM; NULL until narrated
```

to:

```
     summary_line TEXT,            -- one-line description written by the LLM; NULL until narrated
     transcribe_forced_at INTEGER, -- set when a person overruled the "not English" refusal
     forced_from_language TEXT     -- what was heard before they did; the banner's claim
```

- [ ] **Step 6: Run the tests**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests '*ForcedTranscriptTest*' 2>&1 | tail -6
```

Expected: `BUILD SUCCESSFUL`, 4 tests passing.

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt \
        android/app/src/test/java/com/innocorelabs/verbale/ForcedTranscriptTest.kt \
        src/db/schema.ts
git commit -m "feat(db): remember that a refusal was overruled, and what was heard"
```

---

## Task 5: ProcessingEngine honours the flag

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt`

- [ ] **Step 1: Read the flag and pass it**

In `ProcessingEngine.kt`, find the `val qwen3Dir = ModelCatalog.qwen3DirFor(ctx)` line and add above it:

```kotlin
          // Set by "Transcribe it anyway" on a meeting this build already refused. Read per run
          // rather than held, so a reprocess of a forced meeting stays forced.
          val forced = db.transcribeForcedAt(meetingId) != null
```

Change the `nativeTranscribe` call to:

```kotlin
          val json = NativeBridge.nativeTranscribe(
            audioPath, asrFile.absolutePath, RecordingService.SAMPLE_RATE, starts, ends, 0, language,
            if (qwen3Dir.isDirectory) qwen3Dir.absolutePath else "", forced,
          )
```

- [ ] **Step 2: Do not let the success path erase the heard language**

Find `db.setLanguage(meetingId, language)` on the success path (immediately before `db.replaceUtterancesJson`). Replace that single line with:

```kotlin
          // `language` records what the meeting was transcribed IN, so a forced run correctly
          // sets it to the requested code. `forced_from_language` is a different fact — what was
          // heard before somebody overruled us — and it is written once, by markTranscribeForced,
          // and never touched here. Clearing it would empty the banner without breaking anything,
          // which is the whole reason it is a separate column.
          db.setLanguage(meetingId, language)
```

- [ ] **Step 3: Build**

```bash
export ANDROID_HOME=/Users/akshayghosh/Android/Library/SDK
export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home
cd android && ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a \
  -PAUDIONOTES_DEBUG_UPLOAD_SIGNING 2>&1 | tail -4
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt
git commit -m "feat(pipeline): a forced meeting transcribes instead of refusing"
```

---

## Task 6: The marker in every export

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/FileExportModule.kt`
- Test: `android/app/src/test/java/com/innocorelabs/verbale/ForcedTranscriptTest.kt`

- [ ] **Step 1: Write the failing test**

Append to `ForcedTranscriptTest.kt`, inside the class:

```kotlin
  @Test
  fun the_export_marker_names_the_language_that_was_heard() {
    assertEquals(
      "Forced transcript — heard as Turkish, transcribed as English. " +
        "If it was not English, the words below are invented.",
      com.innocorelabs.verbale.pipeline.FileExportModule.forcedMarker("tr"),
    )
  }

  @Test
  fun the_export_marker_still_warns_when_no_language_was_named() {
    assertEquals(
      "Forced transcript — this did not sound like English, and was transcribed as English " +
        "anyway. If it was not English, the words below are invented.",
      com.innocorelabs.verbale.pipeline.FileExportModule.forcedMarker(""),
    )
  }

  @Test
  fun an_unforced_meeting_gets_no_marker() {
    assertNull(com.innocorelabs.verbale.pipeline.FileExportModule.forcedMarkerOrNull(null, "tr"))
  }
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests '*ForcedTranscriptTest*' 2>&1 | tail -12
```

Expected: unresolved reference `forcedMarker`.

- [ ] **Step 3: Add the marker builders**

In `FileExportModule.kt`, add to its `companion object` (create one directly inside the class if none exists):

```kotlin
  companion object {
    /**
     * The line that travels with a forced transcript wherever it goes.
     *
     * The in-app banner protects the person who forced it; this protects everybody they send it
     * to. A PDF of invented minutes with no warning on it is the failure the refusal was built to
     * prevent, merely relocated to somebody else's inbox.
     */
    @JvmStatic
    fun forcedMarker(heardLanguage: String): String {
      val name = languageDisplayName(heardLanguage)
      return if (name != null) {
        "Forced transcript — heard as $name, transcribed as English. " +
          "If it was not English, the words below are invented."
      } else {
        "Forced transcript — this did not sound like English, and was transcribed as English " +
          "anyway. If it was not English, the words below are invented."
      }
    }

    /** Null when the meeting was never forced. */
    @JvmStatic
    fun forcedMarkerOrNull(transcribeForcedAt: Long?, heardLanguage: String?): String? =
      if (transcribeForcedAt == null) null else forcedMarker(heardLanguage ?: "")

    /** English name of a language code, or null when we cannot name it. */
    private fun languageDisplayName(code: String): String? {
      if (code.isBlank()) return null
      val name = java.util.Locale.forLanguageTag(code).getDisplayLanguage(java.util.Locale.ENGLISH)
      return if (name.isBlank() || name.equals(code, ignoreCase = true)) null else name
    }
  }
```

- [ ] **Step 4: Select the columns and prepend the marker**

In `FileExportModule.document(...)`, change the meeting query:

```kotlin
    val meeting = JSONArray(
      db.rawQueryJson(
        "SELECT title,created_at,duration_ms,transcribe_forced_at,forced_from_language " +
          "FROM meetings WHERE id=?",
        arrayOf(meetingId),
      ),
    ).optJSONObject(0)
```

After the `val createdAt = ...` line, add:

```kotlin
    // Null unless somebody overruled the language refusal on this meeting.
    val forcedAt = meeting?.let { if (it.isNull("transcribe_forced_at")) null else it.optLong("transcribe_forced_at") }
    val marker = forcedMarkerOrNull(forcedAt, meeting?.optString("forced_from_language", "") ?: "")
```

Change the PDF branch to put the marker directly under the title block:

```kotlin
    if (format == "pdf") {
      val blocks = pdfBlocks(title, createdAt, minutes, utterances, nameById, edits)
      val withMarker = if (marker == null) blocks else buildList {
        // After the title and date, before any content: a reader who stops at the first paragraph
        // must still have seen it.
        addAll(blocks.take(2))
        add(PdfExport.Block(marker, 10f, bold = true,
                            color = android.graphics.Color.rgb(0x8A, 0x5A, 0x00), spaceBefore = 14f))
        addAll(blocks.drop(2))
      }
      return Document(title, "pdf", "", withMarker)
    }
```

Change the text-format return to:

```kotlin
    val ext = when (format) { "srt" -> "srt"; "txt", "transcript" -> "txt"; else -> "md" }
    val body = when (format) {
      "srt" -> renderSrt(utterances, nameById, edits)
      "txt" -> renderText(title, createdAt, minutes, utterances, nameById, edits)
      "transcript" -> renderTranscript(utterances, nameById, edits)
      else -> renderMarkdown(title, createdAt, minutes, utterances, nameById, edits)
    }
    // SRT gets a real cue rather than a comment, because subtitle players drop comments — a
    // warning nobody can see is not a warning.
    val marked = when {
      marker == null -> body
      format == "srt" -> "0\n00:00:00,000 --> 00:00:04,000\n$marker\n\n" + body
      format == "md" || format !in setOf("srt", "txt", "transcript") -> "> $marker\n\n" + body
      else -> "$marker\n\n" + body
    }
    return Document(title, ext, marked)
```

- [ ] **Step 5: Run the tests**

```bash
cd android && ./gradlew :app:testDebugUnitTest --tests '*ForcedTranscriptTest*' 2>&1 | tail -6
```

Expected: `BUILD SUCCESSFUL`, 7 tests passing.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/pipeline/FileExportModule.kt \
        android/app/src/test/java/com/innocorelabs/verbale/ForcedTranscriptTest.kt
git commit -m "feat(export): a forced transcript says so in every format it leaves in"
```

---

## Task 7: The copy

**Files:**
- Modify: `src/screens/languages.ts`
- Test: `src/screens/__tests__/languages.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/screens/__tests__/languages.test.ts` (create it with `import { ... } from '../languages';` at the top if it does not exist):

```ts
import { forceTranscribePrompt, forcedTranscriptNote } from '../languages';

describe('overruling a refusal', () => {
  it('states both outcomes, not just the one the user wants', () => {
    const p = forceTranscribePrompt('tr');
    expect(p.title).toBe('Transcribe it anyway?');
    expect(p.body).toContain('sounds like Turkish');
    expect(p.body).toContain('transcribe it as English');
    // The half people skip is the half that matters.
    expect(p.body).toContain('invented text that reads as real');
  });

  it('still warns when detection never named a language', () => {
    const p = forceTranscribePrompt(null);
    expect(p.body).toContain('does not sound like English');
    expect(p.body).toContain('invented text that reads as real');
  });

  it('names the heard language in the banner', () => {
    expect(forcedTranscriptNote('tr')).toBe(
      'Forced transcript — heard as Turkish, transcribed as English. ' +
        'If it was not English, the words below are invented.',
    );
  });

  it('warns in the banner even with no named language', () => {
    expect(forcedTranscriptNote(null)).toContain('did not sound like English');
    expect(forcedTranscriptNote(null)).toContain('invented');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- languages 2>&1 | tail -12
```

Expected: `Cannot find module` or `forceTranscribePrompt is not a function`.

- [ ] **Step 3: Add the copy**

Append to `src/screens/languages.ts`:

```ts
/**
 * What to ask before overruling a refusal.
 *
 * Both outcomes, in the order that decides the answer. A generic "are you sure" would get tapped
 * through: the person already believes the recording is English, so the only useful sentence is
 * the one describing what happens if they are wrong — fluent invented text that reads as real,
 * which is the failure the refusal exists to prevent.
 */
export function forceTranscribePrompt(code: string | null | undefined): {
  title: string;
  body: string;
} {
  const name = languageName(code);
  const heard = name ? `This sounds like ${name}.` : 'This does not sound like English.';
  return {
    title: 'Transcribe it anyway?',
    body:
      `${heard} If we heard wrong, this will transcribe it as English. ` +
      'If we heard right, the result will be invented text that reads as real.',
  };
}

/**
 * The banner a forced transcript carries for the rest of its life.
 *
 * Not dismissible where it is rendered, and composed here rather than stored, for the reason
 * unsupportedLanguageNote records: a status message parked in a content field outlives its status.
 * The person who forced it knew what they were doing; the person reading it three weeks later did
 * not.
 */
export function forcedTranscriptNote(code: string | null | undefined): string {
  const name = languageName(code);
  return name
    ? `Forced transcript — heard as ${name}, transcribed as English. ` +
        'If it was not English, the words below are invented.'
    : 'Forced transcript — this did not sound like English, and was transcribed as English ' +
        'anyway. If it was not English, the words below are invented.';
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- languages 2>&1 | tail -6
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/screens/languages.ts src/screens/__tests__/languages.test.ts
git commit -m "feat(copy): say what forcing a transcript costs, before and after"
```

---

## Task 8: The refused screen

**Files:**
- Modify: `src/pipeline/types.ts`
- Modify: `src/db/queries.ts`
- Modify: `src/screens/MeetingScreen.tsx`

- [ ] **Step 1: Add the fields to the `Meeting` type**

In `src/pipeline/types.ts`, inside `interface Meeting`, after `summaryLine`:

```ts
  /**
   * Set when a person overruled a "not English" refusal on this meeting. Both the reason the run
   * bypassed detection and the reason its result is marked forever.
   */
  transcribeForcedAt?: number | null;
  /** What was heard before they overruled it. Null when detection never named a language. */
  forcedFromLanguage?: string | null;
```

- [ ] **Step 2: Select them**

In `src/db/queries.ts`, there are three selects containing `summary_line AS summaryLine `. Change each occurrence of:

```
'status, tier_used AS tierUsed, audio_retained AS audioRetained, summary_line AS summaryLine '
```

to:

```
'status, tier_used AS tierUsed, audio_retained AS audioRetained, summary_line AS summaryLine, ' +
        'transcribe_forced_at AS transcribeForcedAt, forced_from_language AS forcedFromLanguage '
```

- [ ] **Step 3: Add the action to the refused screen**

In `src/screens/MeetingScreen.tsx`, add to the imports on line 1:

```ts
import { unsupportedLanguageNote, forceTranscribePrompt, forcedTranscriptNote } from './languages';
```

Add this callback next to `onReprocess`:

```tsx
  /**
   * Overrule a refusal we may have got wrong.
   *
   * Stamps the meeting first, then reprocesses: ProcessingEngine reads the column at the top of
   * its ASR stage, so the order matters — reprocessing first would run the same detection and
   * refuse again, and the button would look broken.
   */
  const onTranscribeAnyway = useCallback(() => {
    const prompt = forceTranscribePrompt(meeting?.language);
    Alert.alert(prompt.title, prompt.body, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Transcribe anyway',
        style: 'destructive',
        onPress: async () => {
          await db.markTranscribeForced(meetingId, meeting?.language ?? null);
          await refresh();
          await onReprocess();
        },
      },
    ]);
  }, [meeting?.language, meetingId, onReprocess, refresh]);
```

Replace the refused block's closing `Txt` (the one reading "Your recording is kept. Redo will transcribe it…") with:

```tsx
          <Txt variant="sub" color={colors.inkDim} style={st.emptyBody}>
            Your recording is kept. Redo will transcribe it the day its language is supported.
          </Txt>
          {/* The only route onward used to be Redo, buried in the overflow sheet — which re-runs
              the same detection and lands back here. An action that appears to do nothing is
              worse than no action. */}
          <Button title="Transcribe it anyway" onPress={onTranscribeAnyway} style={st.emptyAction} />
```

- [ ] **Step 4: Add the banner**

Immediately inside the non-refused, non-empty branch — before `<Segmented items={TABS} …>` — add:

```tsx
          {meeting?.transcribeForcedAt ? (
            <View style={st.forcedBanner}>
              <Txt variant="sub" color={colors.warning}>
                {forcedTranscriptNote(meeting?.forcedFromLanguage)}
              </Txt>
            </View>
          ) : null}
```

Add to the stylesheet, next to `emptyBody`:

```ts
  forcedBanner: {
    backgroundColor: colors.warningSoft,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  emptyAction: { marginTop: 20, alignSelf: 'center' },
```

- [ ] **Step 5: Add `markTranscribeForced` to the db façade**

No bridge method is needed: `src/db/queries.ts` writes this database directly through
`Storage.query`, which is how `clearNarration` updates `meetings` two functions above. Add to the
same exported object, next to `clearNarration`:

```ts
  /**
   * Record that a person overruled the "not English" refusal on this meeting.
   *
   * `heardLanguage` is passed in by the caller rather than read here: the meeting row still holds
   * it at the moment of the tap, and will not once the forced run succeeds and overwrites
   * `language` with the requested code. That is the whole reason it is a separate column.
   */
  markTranscribeForced: async (meetingId: string, heardLanguage: string | null) => {
    await run(
      'UPDATE meetings SET transcribe_forced_at = ?, forced_from_language = ? WHERE id = ?',
      [Date.now(), heardLanguage && heardLanguage.trim() ? heardLanguage : null, meetingId],
    );
  },
```

- [ ] **Step 6: Typecheck, lint and test**

```bash
npx tsc --noEmit && npm run lint && npm test 2>&1 | tail -8
```

Expected: no type errors, no lint errors, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/types.ts src/db/queries.ts src/screens/MeetingScreen.tsx
git commit -m "feat(ui): a wrong refusal has a way back, and its result says so"
```

---

## Task 9: Verify on hardware

**Files:** none — this is the gate.

- [ ] **Step 1: Confirm a device is attached**

```bash
export ANDROID_HOME=/Users/akshayghosh/Android/Library/SDK
export PATH=$ANDROID_HOME/platform-tools:$PATH
adb devices -l
```

Expected: one line with `device` (not `unauthorized`, not `offline`).

- [ ] **Step 2: Run the native suite**

```bash
npm run test:device
```

Expected: `NativePipelineTest` passes with **no skips**. A skip means the models are missing — see `docs/ANDROID_TESTING.md` for restoring them from `eval/models/` without re-downloading. The JNI signature changed in Task 3, so this is the run that proves the app still calls it correctly.

- [ ] **Step 3: Exercise the override end to end, by hand**

1. Open a meeting whose status is `NOT ENGLISH` (or record ~40s of non-English speech and let it refuse).
2. Confirm the refused screen shows **Transcribe it anyway**.
3. Tap it; confirm the dialog names the heard language and both outcomes.
4. Confirm; wait for processing.
5. Confirm a transcript appears and the amber banner sits above the tabs.
6. Export as PDF and as Markdown; confirm the marker is in both.
7. Force-quit and reopen the meeting; confirm the banner is still there.

- [ ] **Step 4: Commit any fixes, then update the docs**

In `docs/NEXT.md`, change item 6's row to record that it shipped, in the style of items 3 and 4:

```
| 6 | ~~Give the refused meeting a next step~~ **DONE — "Transcribe it anyway"** | me | S | A wrong refusal was unrecoverable: Redo re-runs the same detection and reaches the same verdict. There is now a per-meeting override, with a confirmation that states both outcomes, a non-dismissible banner, and the same marker carried into every export — because the forwarded PDF is where invented minutes actually do harm. `docs/superpowers/specs/2026-09-05-transcribe-it-anyway-design.md`. |
```

```bash
git add docs/NEXT.md
git commit -m "docs: item 6 ships — a wrong refusal has a way back"
```

---

## Self-review

**Spec coverage.** Data → Task 4. Native → Tasks 1–2. Kotlin → Tasks 3, 5. UI action, confirmation and banner → Tasks 7, 8. Exports → Task 6. Testing table → Tasks 1, 4, 6, 7 (unit) and 9 (device). The spec's "must NOT clear `forced_from_language`" warning is Task 5 Step 2, and is pinned by `ForcedTranscriptTest`.

**Type consistency.** `skip_language_refusal` is the C++ name throughout (Tasks 1, 2, 3); `forceLanguage` is the Kotlin/JNI parameter (Task 3); `transcribe_forced_at` / `forced_from_language` are the columns (Task 4) and `transcribeForcedAt` / `forcedFromLanguage` their camelCase aliases (Task 8). `markTranscribeForced` is the same name in `AudioDb` (Task 4), the bridge (Task 8) and the screen (Task 8). `forcedMarker` / `forcedMarkerOrNull` are Kotlin (Task 6); `forcedTranscriptNote` / `forceTranscribePrompt` are TypeScript (Task 7) — deliberately different names because they are different implementations of the same sentence, and Task 6's and Task 7's tests pin the wording to match.

**Resolved during review.** An earlier draft added a Kotlin `@ReactMethod` to write the columns. `src/db/queries.ts` already writes `meetings` directly through `Storage.query` — `clearNarration` does exactly that — and both sides share one `audionotes.db`, so the write is TypeScript and Kotlin only reads. One writer, one place.

**File-table correction.** `AudioPipelineModule.kt` is no longer touched; ignore its absence from the table above being a gap.
