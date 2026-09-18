# Phase 5 — Session 1 execution sheet (native and data: vocabulary rules, dictation mode)

*18 September 2026. For the session that builds it. Do not design anything: every file, function,
string and test below is decided. Execute the steps in order. The design
(`2026-09-18-phase-5-vocabulary-and-dictation-design.md`) is background you do not need to read.
The C++ this phase needs is already built and tested (`9f05928`): `applySpokenPunctuation` in
`cpp/minutes/dictation.h` and the `dictation` narrative shape. Nothing here opens a model.*

---

## 0. Rules

- **Token discipline.** Read only the files and line ranges in §1. Never print a file over 200
  lines; `grep -n` then `sed -n 'A,Bp'` at most 60 lines at a time. `AudioDb.kt` is 3,100 lines:
  only the ranges named. Every command below ends in its filter — run it exactly. Do not re-read
  a file after editing it. Do not paste code into your messages; commit it.
- **TDD + mutant.** Test first, see it fail, code, see it pass, apply the named mutant, see the
  test fail, restore, green. Record each mutant in the progress file's *Mutants* as it happens.
- **Commit after each step**, subject in the house style (`git log --oneline -6`). Never push.
  Never run `connectedDebugAndroidTest`. **`git status` must be clean before you stop.**
  **Indent like the surrounding file: two spaces, Kotlin and TypeScript alike.**
- **Progress file.** First action: create `docs/superpowers/reports/phase-5-progress.md` with the
  step list of §2 as checkboxes and the headings *Decisions*, *Mutants*, *Notes for the next
  session*. Update and commit it with every step.
- **Hand-over at 150 steps**, whatever remains: finish the step you are on, commit, update the
  progress file, stop. Stop also when a §6 condition is met.
- **Device.** `export ANDROID_SERIAL=36091FDH30034G`. Step 7 needs the phone; if
  `adb devices | grep -c 36091FDH30034G` prints 0, do Steps 1–6, write the note in the progress
  file, and stop.

---

## 1. Relevant files (the only files you read)

| File | Lines | Why |
|---|---|---|
| `cpp/minutes/dictation.h` | all (25 lines) | the C++ function the JNI wraps |
| `cpp/jni/audionotes_jni.cpp` | 1090–1115 (`nativeFoldSections`) | the JNI shape to copy |
| `android/.../pipeline/NativeBridge.kt` | 310–325 | where the extern goes |
| `android/.../data/AudioDb.kt` | 478–486 (`insertMeeting`), 1015–1030 (`utterances`), 2794–2800 (`SCHEMA` head), 3026–3100 (`ADDED_COLUMNS`), 2561–2580 (`foldVoice` — the style of a new block) | schema mirror; the reads and writes you add beside |
| `android/.../data/BackupManager.kt` | 60–70 (`TABLES`) | append one table |
| `android/.../pipeline/ProcessingEngine.kt` | 150–160, 196–206 (the ASR stage), 222–232 (the diarize guard), 338–348 (`suggestTemplate` call) | the three hooks |
| `android/.../pipeline/CaptureController.kt` | 368–385 | where a meeting is created |
| `android/.../pipeline/AudioPipelineModule.kt` | 156–170 | where `start` reads its config |
| `android/.../pipeline/StorageModule.kt` | 228–260 | the `@ReactMethod` shape to copy |
| `android/.../pipeline/TemplateSuggester.kt` | 1–20 | the shape of a pure rule object |
| `android/app/src/test/.../pipeline/TemplateSuggesterTest.kt` | all (34 lines) | how a golden is read |
| `android/app/src/test/.../SchemaTest.kt` | 210–260, 310–320 | the tests to extend |
| `android/app/src/androidTest/.../PeopleDbTest.kt` | 1–60 | the device-test shape (trial grant, fixtures) |
| `android/app/src/androidTest/.../VerificationProbeTest.kt` | all (60 lines) | extend the probe |
| `src/db/schema.ts` | 20–66 (`meetings`, `utterances`) | the TS mirror |
| `src/db/__tests__/schema.test.ts` | 85–160 | the tests to extend |
| `src/native/NativeStorage.ts` | 45–60 | the spec lines to add |
| `src/native/NativeAudioPipeline.ts` | 1–30 | the `start` options type |
| `jest.setup.js` | 32–52 | the `Storage` stubs to add |
| `scripts/device-verify.sh` | 70–85 (`CLASSES`) | add one class |

**Files that must not change:** anything under `cpp/` (done); `src/screens/**`; `src/pipeline/**`
except `types.ts`; `src/components/**`; `src/navigation/**`; `Narrator.kt`; `LiveTranscriber.kt`;
every test not named below.

---

## 2. Implementation sequence

### Step 1 — schema: `meetings.mode`, `utterances.text_raw`, the `vocabulary` table, backup

**1a.** `src/db/schema.ts`, in `CREATE TABLE IF NOT EXISTS meetings (…)`: after the line
`template_source TEXT` add a comma to it and then

```sql
     -- Phase 5: 'dictation' for a meeting recorded in dictation mode; NULL is an ordinary meeting.
     mode TEXT
```

In `CREATE TABLE IF NOT EXISTS utterances (…)`: after `text TEXT NOT NULL` add a comma and

```sql
     -- Phase 5: what the recogniser wrote, kept only when a vocabulary rule or spoken punctuation
     -- changed `text`; NULL means `text` is the recogniser's own wording.
     text_raw TEXT
```

After the `speakers` table statement add a new statement:

```ts
  `CREATE TABLE IF NOT EXISTS vocabulary (
     id TEXT PRIMARY KEY,
     heard TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- what the recogniser writes: "in over"
     meant TEXT NOT NULL,                          -- what the person means: "Innova"
     source TEXT NOT NULL,                         -- 'typed' | 'learned'
     created_at INTEGER NOT NULL,
     uses INTEGER NOT NULL DEFAULT 0               -- how many lines it has corrected
   );`,
```

**1b.** `AudioDb.kt`: in `SCHEMA` (line ~2794, the array of DDL strings) add the same
`vocabulary` DDL as a Kotlin triple-quoted string right after the `speakers` DDL (find it with
`grep -n "CREATE TABLE IF NOT EXISTS speakers" AudioDb.kt`). In `ADDED_COLUMNS` (line ~3026),
after `Triple("speakers", "suggested_person", "TEXT"),` add

```kotlin
      // Phase 5: 'dictation' for a meeting recorded in dictation mode; NULL is an ordinary meeting.
      Triple("meetings", "mode", "TEXT"),
      // Phase 5: the recogniser's own wording, kept only when a rule or spoken punctuation changed
      // `text`. NULL means `text` is what was recognised.
      Triple("utterances", "text_raw", "TEXT"),
```

`BackupManager.kt` `TABLES`: append `"vocabulary"` after `"people"` (same line, before the
closing parenthesis).

**1c.** Tests. `SchemaTest.kt`: rename `meetingsHasTheSameTwentyOneColumnsAsTheJavaScriptMirror`
to `…TwentyTwo…` and add `"mode"` at the end of its `expected` list; add
`@Test fun modeAndTextRawAreAddedColumns()` asserting both triples are in
`AudioDb.addedColumnsForTest()` (see how `theMeetingTypeAndItsSourceAreAddedColumns` does it at
line 218); add `@Test fun vocabularyTableIsInSchema()` asserting `schema.contains("CREATE TABLE IF NOT EXISTS vocabulary")`
and that its DDL contains `UNIQUE COLLATE NOCASE`; change `backupManagerTablesEndsWithPeople` to
`backupManagerTablesEndsWithVocabularyAfterPeople`: `tables.last() == "vocabulary"` and
`tables[tables.size - 2] == "people"`. `schema.test.ts`: in the meetings describe add
`it('mode is a nullable TEXT with no default')` in the shape of the `template` test at line ~142;
add `it('utterances has text_raw, nullable TEXT')`; add `it('vocabulary has the six columns and heard is UNIQUE COLLATE NOCASE')`.
The existing "has every column AudioDb creates or adds" test will fail until both mirrors agree —
that is the point.

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests '*SchemaTest*' -q 2>&1 | grep -E "error:|FAILED|BUILD" | tail -5` then the XML one-liner
(`python3 -c "import glob,xml.etree.ElementTree as E;[print(f.split('/')[-1],E.parse(f).getroot().attrib.get('tests'),E.parse(f).getroot().attrib.get('failures')) for f in glob.glob('app/build/test-results/testDebugUnitTest/*SchemaTest*.xml')]"`)
→ `failures 0`, tests 22. `npx jest src/db/__tests__/schema.test.ts --forceExit --silent 2>&1 | tail -6`.
*Mutants:* remove `mode` from `schema.ts` → the mirror test fails; remove the `text_raw` Triple →
Kotlin fails; move `"vocabulary"` before `"people"` → the backup test fails.

Commit: `feat(vocab): schema — meetings.mode, utterances.text_raw, the vocabulary table`.

### Step 2 — `Vocabulary.kt`, the pure rule, with its golden

**2a.** Create `android/app/src/main/java/com/innocorelabs/verbale/pipeline/Vocabulary.kt`:

```kotlin
package com.innocorelabs.verbale.pipeline

/**
 * Correction rules for the transcript (Phase 5, custom vocabulary): "in over" -> "Innova".
 * Applied after recognition, never as a recogniser prompt — measured 18 Sep, a prompt made
 * whisper drop words on every meeting (design §2). Pure: no database, so a golden pins it.
 */
object Vocabulary {
  data class Rule(val heard: String, val meant: String)

  /**
   * Every rule applied to [text]: whole words only, case-insensitive, longest `heard` first so
   * "in over there" beats "in over"; `meant` is written exactly as typed. Text no rule touches
   * comes back byte for byte (the same String instance).
   */
  fun apply(text: String, rules: List<Rule>): String {
    if (rules.isEmpty() || text.isEmpty()) return text
    var out = text
    for (r in rules.sortedByDescending { it.heard.length }) {
      val heard = r.heard.trim()
      if (heard.isEmpty()) continue
      val re = Regex("(?<![\\p{L}\\p{N}])" + Regex.escape(heard) + "(?![\\p{L}\\p{N}])", RegexOption.IGNORE_CASE)
      out = re.replace(out) { Regex.escapeReplacement(r.meant) }
    }
    return if (out == text) text else out
  }
}
```

**2b.** Create `cpp/tests/golden/vocabulary_apply.json`:

```json
{
  "note": "Vocabulary.apply: whole words, case-insensitive, longest heard first, meant as typed; untouched text is returned unchanged. Read by VocabularyTest.kt.",
  "cases": [
    { "name": "the report's own example", "rules": [{"heard": "in over", "meant": "Innova"}], "text": "we sold it to in over last week", "expect": "we sold it to Innova last week" },
    { "name": "case-insensitive on heard, meant as typed", "rules": [{"heard": "prey", "meant": "Priya"}], "text": "Prey will send the deck; prey said so", "expect": "Priya will send the deck; Priya said so" },
    { "name": "whole words only", "rules": [{"heard": "prey", "meant": "Priya"}], "text": "the osprey preyed on it", "expect": "the osprey preyed on it" },
    { "name": "longest heard first", "rules": [{"heard": "in over", "meant": "Innova"}, {"heard": "in over there", "meant": "Innovathere"}], "text": "put it in over there", "expect": "put it Innovathere" },
    { "name": "punctuation next to the word is fine", "rules": [{"heard": "in over", "meant": "Innova"}], "text": "In over, the client, agreed.", "expect": "Innova, the client, agreed." },
    { "name": "no rules, same text", "rules": [], "text": "unchanged", "expect": "unchanged" },
    { "name": "a rule that matches nothing", "rules": [{"heard": "innova", "meant": "Innova"}], "text": "nothing here", "expect": "nothing here" },
    { "name": "unicode letters count as letters", "rules": [{"heard": "ravi", "meant": "Ravi"}], "text": "ravié ravi", "expect": "ravié Ravi" }
  ]
}
```

**2c.** Create `android/app/src/test/java/com/innocorelabs/verbale/pipeline/VocabularyTest.kt`
reading the golden exactly the way `TemplateSuggesterTest.kt` reads its own (copy its `golden`
lazy block, change the file name), one `@Test fun everyRowOfTheGoldenTable()` looping the cases
and asserting `Vocabulary.apply(text, rules) == expect` with the case name in the message; a
second `@Test fun untouchedTextIsTheSameInstance()` asserting
`Vocabulary.apply("x", listOf(Rule("y","z"))) === "x"` is not required — assert `==` and that
`apply("x", emptyList())` returns the same instance with `assertSame`.

Run: `./gradlew :app:testDebugUnitTest --tests '*VocabularyTest*' -q …` → tests 2, failures 0.
*Mutants:* drop the `sortedByDescending` → "longest heard first" fails; drop `IGNORE_CASE` →
the case test fails; use `\\b` instead of the lookarounds → the unicode case fails.

Commit: `feat(vocab): the correction rule, golden-tested`.

### Step 3 — JNI `nativeApplySpokenPunctuation`

**3a.** `cpp/jni/audionotes_jni.cpp`: add `#include "minutes/dictation.h"` next to
`#include "minutes/templates.h"`. Directly after the `nativeFoldSections` function (line ~1098–1110):

```cpp
// Phase 5 (dictation): spoken punctuation -> marks (minutes/dictation.h). One string in, one out;
// promptCall's shape.
extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeApplySpokenPunctuation(
    JNIEnv* env, jobject /*thiz*/, jstring jText) {
  return promptCall(env, jText, &audionotes::applySpokenPunctuation);
}
```

**3b.** `NativeBridge.kt`, after `nativeFoldSections`:

```kotlin
  /** Phase 5 (dictation): "full stop", "comma", "new paragraph" … become the marks. Dictation mode only. */
  external fun nativeApplySpokenPunctuation(text: String): String
```

**3c.** `NativePipelineTest.kt` (androidTest): a sibling of `the_section_fold_crosses_the_jni_seam`:
`the_spoken_punctuation_crosses_the_jni_seam` asserting
`NativeBridge.nativeApplySpokenPunctuation("we will not ship full stop new paragraph tell finance comma the invoice is late question mark") == "We will not ship.\n\nTell finance, the invoice is late?"`
and that `"the trial period ends"` comes back unchanged. (Runs in Step 7.)

Build check: `cd android && ./gradlew :app:compileDebugKotlin -q 2>&1 | grep -E "^e: |error:" | head -5` → nothing.
Commit: `feat(dictation): nativeApplySpokenPunctuation across the JNI seam`.

### Step 4 — `AudioDb`: the reads and writes

In `AudioDb.kt`, directly after `peopleCount()` (grep `fun peopleCount`), a new block (two-space
indentation, doc comments in the file's voice):

```kotlin
  // ---- Phase 5: vocabulary rules and dictation mode -----------------------------------------

  /** 'dictation' for a meeting recorded in dictation mode; null for an ordinary meeting. */
  fun mode(meetingId: String): String? {
    db.rawQuery("SELECT mode FROM meetings WHERE id=?", arrayOf(meetingId)).use { c ->
      return if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null
    }
  }

  fun setMode(meetingId: String, mode: String?) {
    db.execSQL("UPDATE meetings SET mode=? WHERE id=?", arrayOf<Any?>(mode, meetingId))
  }

  /** Every rule, longest `heard` first is Vocabulary.apply's job; this is insertion order. */
  fun vocabularyRules(): List<Vocabulary.Rule> {
    val out = ArrayList<Vocabulary.Rule>()
    db.rawQuery("SELECT heard, meant FROM vocabulary ORDER BY created_at", null).use { c ->
      while (c.moveToNext()) out.add(Vocabulary.Rule(c.getString(0), c.getString(1)))
    }
    return out
  }

  /** Every rule as JSON for the screens: [{id, heard, meant, source, createdAt, uses}]. */
  fun vocabularyJson(): String {
    val arr = JSONArray()
    db.rawQuery("SELECT id, heard, meant, source, created_at, uses FROM vocabulary ORDER BY created_at", null).use { c ->
      while (c.moveToNext()) {
        arr.put(
          JSONObject().put("id", c.getString(0)).put("heard", c.getString(1)).put("meant", c.getString(2))
            .put("source", c.getString(3)).put("createdAt", c.getLong(4)).put("uses", c.getInt(5)),
        )
      }
    }
    return arr.toString()
  }

  /**
   * Add or replace a rule (`heard` is unique, case-insensitively: typing "In Over" over an
   * existing "in over" replaces its `meant`). Returns the rule's id. Blank `heard` or `meant`
   * throws IllegalArgumentException — the screen validates first; this is the last line.
   */
  fun putVocabulary(heard: String, meant: String, source: String): String {
    val h = heard.trim(); val m = meant.trim()
    require(h.isNotEmpty() && m.isNotEmpty()) { "heard and meant must not be blank" }
    require(source == "typed" || source == "learned") { "source must be typed or learned" }
    val existing = db.rawQuery("SELECT id FROM vocabulary WHERE heard=? COLLATE NOCASE", arrayOf(h))
      .use { c -> if (c.moveToFirst()) c.getString(0) else null }
    if (existing != null) {
      db.execSQL("UPDATE vocabulary SET meant=?, source=? WHERE id=?", arrayOf<Any?>(m, source, existing))
      return existing
    }
    val id = UUID.randomUUID().toString()
    db.execSQL(
      "INSERT INTO vocabulary(id, heard, meant, source, created_at, uses) VALUES(?,?,?,?,?,0)",
      arrayOf<Any?>(id, h, m, source, System.currentTimeMillis()),
    )
    return id
  }

  fun deleteVocabulary(id: String) {
    db.execSQL("DELETE FROM vocabulary WHERE id=?", arrayOf<Any?>(id))
  }

  /**
   * Run every rule — and, for a dictation meeting, the spoken punctuation — over one meeting's
   * utterances. The recogniser's wording is kept in text_raw the first time a line changes and
   * never overwritten after, so a second pass (a new rule) still knows what was heard.
   * `punctuate` turns spoken marks into marks; pass NativeBridge::nativeApplySpokenPunctuation
   * (the DB layer does not load the native library itself). Returns how many lines changed.
   */
  fun applyVocabularyToMeeting(
    meetingId: String,
    punctuate: ((String) -> String)?,
    rules: List<Vocabulary.Rule> = vocabularyRules(),
  ): Int {
    if (rules.isEmpty() && punctuate == null) return 0
    var changed = 0
    val usesById = HashMap<String, Int>()
    db.beginTransaction()
    try {
      val rows = ArrayList<Triple<String, String, String?>>()  // id, text, text_raw
      db.rawQuery("SELECT id, text, text_raw FROM utterances WHERE meeting_id=?", arrayOf(meetingId)).use { c ->
        while (c.moveToNext()) rows.add(Triple(c.getString(0), c.getString(1), if (c.isNull(2)) null else c.getString(2)))
      }
      for ((id, text, raw) in rows) {
        var next = Vocabulary.apply(text, rules)
        if (punctuate != null) next = punctuate(next)
        if (next == text) continue
        db.execSQL(
          "UPDATE utterances SET text=?, text_raw=COALESCE(text_raw, ?) WHERE id=?",
          arrayOf<Any?>(next, raw ?: text, id),
        )
        changed++
      }
      if (changed > 0 && rules.isNotEmpty()) {
        // Count a use per rule per changed line — an approximation the screen shows as "used N times".
        for (r in rules) {
          val n = rows.count { Vocabulary.apply(it.second, listOf(r)) != it.second }
          if (n > 0) db.execSQL("UPDATE vocabulary SET uses=uses+? WHERE heard=? COLLATE NOCASE", arrayOf<Any?>(n, r.heard))
        }
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
    return changed
  }
```

Also: `utterances(meetingId)` at line 1015 stays as it is (`Utt` has no `text_raw`; nothing reads
it yet). Build check as in Step 3. Commit: `feat(vocab): AudioDb — rules, mode, applyVocabularyToMeeting`.

### Step 5 — the three pipeline hooks and the mode at creation

**5a.** `ProcessingEngine.kt`, ASR stage: directly after
`val count = db.replaceUtterancesJson(meetingId, asr.getJSONArray("utterances").toString())` (line ~202) insert

```kotlin
          // Phase 5: correction rules, and for a dictation meeting the spoken punctuation, over
          // the lines just written — before minutes, items, narration and the search index read
          // them. Free tier: no rules (vocabulary is Pro); dictation's marks apply to everyone.
          try {
            val dictation = db.mode(meetingId) == "dictation"
            val rulesAllowed = LicenceStore.entitled(ctx)
            val changed = db.applyVocabularyToMeeting(
              meetingId,
              if (dictation) { t: String -> NativeBridge.nativeApplySpokenPunctuation(t) } else null,
              if (rulesAllowed) db.vocabularyRules() else emptyList(),
            )
            if (changed > 0) Log.i(TAG, "vocabulary changed $changed line(s) for $meetingId")
          } catch (e: Throwable) {
            Log.w(TAG, "vocabulary failed for $meetingId", e)
          }
```

(On free, `rules` is empty and only a dictation meeting's marks apply — vocabulary is Pro.)

**5b.** Diarize guard, line ~226: change
`if (transcribed && segModel != null && segModel.exists() && embModel != null && embModel.exists()) {`
to

```kotlin
        val dictation = db.mode(meetingId) == "dictation"
        if (dictation) {
          // Phase 5: one voice by definition. Skipped, not attempted: the speaker rows would be
          // "Speaker 1" alone and the stage costs minutes on a long note.
          Log.i(TAG, "Diarization skipped for $meetingId (dictation)")
          db.setDiarSkippedReason(meetingId, null)
          listener.onStage("diarize", 1, 1)
        } else if (transcribed && segModel != null && segModel.exists() && embModel != null && embModel.exists()) {
```

**5c.** `suggestTemplate` (companion function, grep `internal fun suggestTemplate`): first line
of its body becomes

```kotlin
      if (db.mode(meetingId) == "dictation") { db.setTemplate(meetingId, "dictation", AudioDb.TemplateSource.SUGGESTED); return }
```

**5d.** `CaptureController.start(context, tier, capMs)` gains a fourth parameter
`mode: String? = null`; after `insertMeeting(…)` (line ~382) add
`if (mode == "dictation") AudioDb.get(context).setMode(meetingId, "dictation")`.
`AudioPipelineModule.start`: after `val capMs = …` add
`val mode = if (config.hasKey("mode")) config.getString("mode") else null` and pass it:
`CaptureController.start(ctx, tier, capMs, mode)`. `src/native/NativeAudioPipeline.ts`: add
`mode?: 'dictation';` to the `start` options type with the comment `// Phase 5: record in dictation mode (one voice, spoken punctuation, the note as the write-up).`

Build check; `npx tsc --noEmit 2>&1 | tail -3`. Commit: `feat(dictation): the mode at creation; rules and marks after recognition; no diarization for a dictated note`.

### Step 6 — `StorageModule` + the TS spec + stubs + wrappers

**6a.** `StorageModule.kt`, after `forgetVoices` (line ~251), in the same shape:

```kotlin
  @ReactMethod
  fun vocabulary(promise: Promise) {
    try { promise.resolve(AudioDb.get(ctx).vocabularyJson()) } catch (e: Exception) { promise.reject("db_vocabulary", e) }
  }

  @ReactMethod
  fun putVocabulary(heard: String, meant: String, source: String, promise: Promise) {
    try { promise.resolve(AudioDb.get(ctx).putVocabulary(heard, meant, source)) } catch (e: Exception) { promise.reject("db_vocabulary", e) }
  }

  @ReactMethod
  fun deleteVocabulary(id: String, promise: Promise) {
    try { AudioDb.get(ctx).deleteVocabulary(id); promise.resolve(null) } catch (e: Exception) { promise.reject("db_vocabulary", e) }
  }

  /** Re-run the rules over one meeting now (after a rule is added from its transcript). Pro only. */
  @ReactMethod
  fun applyVocabulary(meetingId: String, promise: Promise) {
    try {
      val db = AudioDb.get(ctx)
      if (!LicenceStore.entitled(ctx)) { promise.resolve(0.0); return }
      val dictation = db.mode(meetingId) == "dictation"
      val changed = db.applyVocabularyToMeeting(meetingId, if (dictation) { t: String -> NativeBridge.nativeApplySpokenPunctuation(t) } else null)
      if (changed > 0) db.reindexMeeting(meetingId)
      promise.resolve(changed.toDouble())
    } catch (e: Exception) { promise.reject("db_vocabulary", e) }
  }
```

(`reindexMeeting` is what `StorageModule.reindex` already calls.) Add
`import com.innocorelabs.verbale.billing.LicenceStore` if absent.

**6b.** `src/native/NativeStorage.ts` after `forgetVoices():`:

```ts
  // Phase 5: correction rules ("in over" -> "Innova"), Pro. JSON array of VocabularyRule.
  vocabulary(): Promise<string>;
  putVocabulary(heard: string, meant: string, source: 'typed' | 'learned'): Promise<string>;
  deleteVocabulary(id: string): Promise<void>;
  // Re-run every rule over one meeting's lines now; resolves with how many lines changed.
  applyVocabulary(meetingId: string): Promise<number>;
```

`jest.setup.js` `Storage` block: `vocabulary: jest.fn(async () => '[]'), putVocabulary: jest.fn(async () => 'v1'), deleteVocabulary: jest.fn(async () => {}), applyVocabulary: jest.fn(async () => 0),`.

`src/pipeline/types.ts`: `export interface VocabularyRule { id: string; heard: string; meant: string; source: 'typed' | 'learned'; createdAt: number; uses: number }`
and `Meeting.mode?: 'dictation' | null` with a one-line comment; `src/db/queries.ts` `getMeeting`
selects `mode` too (add `, mode` to its SELECT list); wrappers next to `forgetVoices`:
`vocabulary: () => Storage.vocabulary().then(r => JSON.parse(r) as VocabularyRule[])`,
`putVocabulary: (heard, meant, source) => Storage.putVocabulary(heard, meant, source)`,
`deleteVocabulary: (id) => Storage.deleteVocabulary(id)`,
`applyVocabulary: (meetingId) => Storage.applyVocabulary(meetingId)`.

`npx tsc --noEmit 2>&1 | tail -3` clean; `npx jest src/db --forceExit --silent 2>&1 | tail -5`.
Commit: `feat(vocab): the bridge — vocabulary, put, delete, applyVocabulary`.

### Step 7 — device tests and the probe (phone required)

**7a.** `VocabularyDbTest.kt` (androidTest, copy `PeopleDbTest`'s trial grant/restore and its
`newMeeting` helper): `@Test fun rules_apply_and_keep_the_raw_wording()`: insert a meeting, two
utterances via `replaceUtterancesJson` (texts "we sold it to in over" and "nothing here");
`putVocabulary("in over", "Innova", "typed")` → `applyVocabularyToMeeting(id, null)` returns 1;
the first line's `text` is "we sold it to Innova" and `text_raw` "we sold it to in over"; the
second untouched with NULL raw; `uses` = 1; applying again returns 0 and `text_raw` unchanged;
`putVocabulary("IN OVER", "Innova Ltd", "learned")` replaces (one row, meant updated), and a
second apply now changes the line to "we sold it to Innova Ltd" while `text_raw` is still the
original. `@Test fun dictation_applies_the_marks_and_keeps_raw()`: a meeting with `setMode(id,
"dictation")` and one utterance "tell finance comma the invoice is late full stop"; apply with
`NativeBridge.nativeApplySpokenPunctuation` (call `NativeBridge.ensureLoaded(ctx)` first as
`NativePipelineTest.loadCore` does) → "Tell finance, the invoice is late." with the raw kept.
`@Test fun mode_round_trips()`: null by default, "dictation" after `setMode`, null after
`setMode(id, null)`. `@Test fun put_rejects_blank()`: `putVocabulary(" ", "x", "typed")` throws
`IllegalArgumentException`. Add `com.innocorelabs.verbale.VocabularyDbTest` to `CLASSES` in
`scripts/device-verify.sh` after `PeopleDbTest`.

**7b.** `VerificationProbeTest`: print `mode=` for each meeting (`m.opt("mode")`), the count and
rows of `vocabulary` (`SELECT heard, meant, source, uses FROM vocabulary`), and for each of the
first 6 utterances whether `text_raw IS NOT NULL`.

Run: `scripts/device-verify.sh VocabularyDbTest > /tmp/dv.log 2>&1; grep -E "^==>|OK \(|FAILURES|test=|Failure" /tmp/dv.log | tail -12`
→ `OK (4 tests)`. Then `scripts/device-verify.sh NativePipelineTest > /tmp/dv2.log 2>&1; grep -E "OK \(|FAILURES|Failure" /tmp/dv2.log | tail -4` → `OK (18 tests)`.
*Mutant (device):* in `applyVocabularyToMeeting` write `text_raw=?` instead of
`COALESCE(text_raw, ?)` → the second-apply assertion on `text_raw` fails; restore.

Commit: `test(vocab): VocabularyDbTest on the Pixel; the probe prints mode, rules and raw lines`.
Then the gate: `GATE_STAGES="types js scans mutations kotlin cpp" bash scripts/gate.sh > /tmp/gate.log 2>&1; grep -E "^==>|ok |FAIL|all clear" /tmp/gate.log`
→ all clear. Update the progress file (*Notes for the next session*: anything Session 2 must
know — e.g. the exact `db.*` names), commit, **stop**.

---

## 3. Expected interfaces after this session

```kotlin
Vocabulary.Rule(heard, meant); Vocabulary.apply(text, rules): String
AudioDb.mode(id): String?; setMode(id, mode: String?)
AudioDb.vocabularyRules(): List<Rule>; vocabularyJson(): String; putVocabulary(heard, meant, source): String; deleteVocabulary(id)
AudioDb.applyVocabularyToMeeting(id, punctuate: ((String)->String)?, rules = vocabularyRules()): Int
NativeBridge.nativeApplySpokenPunctuation(text): String
StorageModule: vocabulary(), putVocabulary(heard, meant, source), deleteVocabulary(id), applyVocabulary(meetingId)
CaptureController.start(ctx, tier, capMs, mode: String? = null); AudioPipeline.start({…, mode?: 'dictation'})
```
```ts
db.vocabulary(): Promise<VocabularyRule[]>; db.putVocabulary(heard, meant, 'typed'|'learned'): Promise<string>
db.deleteVocabulary(id): Promise<void>; db.applyVocabulary(meetingId): Promise<number>; Meeting.mode
```

---

## 4. Exact tests and commands

| Step | Command | Must show |
|---|---|---|
| 1 | Kotlin `*SchemaTest*` + XML one-liner | tests 22, failures 0 |
| 1 | `npx jest src/db/__tests__/schema.test.ts --forceExit --silent 2>&1 \| tail -6` | all passed (+3) |
| 2 | Kotlin `*VocabularyTest*` | tests 2, failures 0 |
| 3, 4, 5 | `./gradlew :app:compileDebugKotlin -q 2>&1 \| grep -E "^e: \|error:" \| head -5` | nothing |
| 5, 6 | `npx tsc --noEmit 2>&1 \| tail -3` | nothing |
| 7 | `scripts/device-verify.sh VocabularyDbTest …` | `OK (4 tests)` |
| 7 | `scripts/device-verify.sh NativePipelineTest …` | `OK (18 tests)` |
| 7 | the gate | `gate: all clear` |

---

## 5. Acceptance criteria

- All of §4 green; every test has its recorded mutant in the progress file.
- `git diff --stat 9f05928..HEAD` names only: `schema.ts`, `schema.test.ts`, `AudioDb.kt`,
  `BackupManager.kt`, `SchemaTest.kt`, `Vocabulary.kt`, `VocabularyTest.kt`, `vocabulary_apply.json`,
  `audionotes_jni.cpp`, `NativeBridge.kt`, `NativePipelineTest.kt`, `ProcessingEngine.kt`,
  `CaptureController.kt`, `AudioPipelineModule.kt`, `NativeAudioPipeline.ts`, `StorageModule.kt`,
  `NativeStorage.ts`, `jest.setup.js`, `types.ts`, `queries.ts`, `VocabularyDbTest.kt`,
  `VerificationProbeTest.kt`, `device-verify.sh`, the progress file.
- `git status` clean; indentation two spaces throughout the new blocks.

---

## 6. Stop conditions

- A step needs a change under `cpp/` (other than the one JNI function), in `Narrator.kt`,
  `LiveTranscriber.kt` or any screen: stop, note it, commit, report.
- Two unsuccessful fixes of the same failure: stop, record both, commit, report.
- A gate stage fails in a file you did not touch: do not investigate; record 20 lines, commit,
  report.
- Phone absent at Step 7: do Steps 1–6, note "Step 7 not run — phone unavailable", commit, stop.
- 150 steps: finish the step, commit, update the progress file, stop.
