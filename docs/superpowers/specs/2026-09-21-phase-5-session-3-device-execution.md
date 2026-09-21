# Phase 5 — Session 3 execution sheet (device: the vocabulary DB tests, the probe, the gate's device stage)

*21 September 2026, against `c7fa4a1`. For the ~30-step session that runs it, started ONLY with the
phone attached. Do not design anything. This is Session 1's Step 7, which the phone's absence on
18 and 21 Sep deferred: four instrumented tests on the real SQLCipher database, the seam test
Session 1 already wrote, the probe's three new lines, and the full gate including its device stage.
The by-hand dictation run (report §7) is the founder's, not this session's.*

---

## 0. Rules

- **The device.** `export ANDROID_SERIAL=36091FDH30034G` (the Pixel). First command:
  `~/Library/Android/sdk/platform-tools/adb devices | grep -c "36091FDH30034G.*device$"` → `1`. If it
  prints `0`: stop; write "Session 3 not run — phone absent" in the progress file, commit, report.
  `adb` is not on PATH; use the full path above, or `ADB=~/Library/Android/sdk/platform-tools/adb`.
  If `emulator-5554` is attached instead, it is another project's session — do not use it.
- **Never** run `connectedDebugAndroidTest` (it uninstalls the app and wipes the models and the
  recordings). **Never** run `adb uninstall`. The only install path is `scripts/device-verify.sh`
  (`install -r`, data kept).
- **Token discipline.** Read only the files and ranges in §1. Every device command goes to a log
  file and is read through `grep … | tail`. Logcat only as `adb logcat -d | grep <tag> | tail -20`.
- **TDD + mutant** as always; the one device mutant is named in Step 1. **Commit after each step**,
  house style (`git log --oneline -6`). Never push. **`git status` must be clean before you stop.
  Indent like the surrounding file: two spaces.**
- **Progress file.** `docs/superpowers/reports/phase-5-progress.md`: append `## Session 3` with the
  four steps as checkboxes; tick and commit with each step. Step 4 deletes the file (the report holds
  its content by then).
- **Hand-over at 150 steps** — this session should need about 30.

---

## 1. Relevant files (the only files you read)

| File | Lines | Why |
|---|---|---|
| `android/app/src/androidTest/.../VocabularyDbTest.kt` | all (132) | the test you run (read-only) |
| `android/app/src/androidTest/.../NativePipelineTest.kt` | 50–60 | `loadCore`: the `assumeTrue` on `libonnxruntime.so` and `NativeBridge.ensureLoaded(ctx)` |
| `android/app/src/androidTest/.../VerificationProbeTest.kt` | all (79) | the probe to extend |
| `scripts/device-verify.sh` | 30–85 (`CLASSES`), 186–205 (`am instrument`) | add one class; the runner line the probe reuses |
| `android/.../data/AudioDb.kt` | 2776–2890 | Session 1's Phase 5 block — the functions under test (read-only) |
| `docs/superpowers/reports/2026-09-21-phase-5-vocabulary-and-dictation.md` | §1 (3–8), §3 (41–65), §6 (101–105), §8 (133–153), §9 (154–end) | Step 4: what to rewrite |
| `docs/superpowers/reports/phase-5-progress.md` | all | Step 4: deleted once the report holds it |

**Interfaces you use** (they exist; do not open other files): `AudioDb.get(ctx)`, `db.insertMeeting(id,
title, createdAt, tier, audioPath)`, `db.replaceUtterancesJson(id, json)` (rows `{start_ms, end_ms,
text}`), `db.deleteMeeting(id)`, `db.rawQueryJson(sql, args: Array<String?>)`, `db.mode(id): String?`,
`db.setMode(id, mode: String?)`, `db.vocabularyRules(): List<Vocabulary.Rule>`, `db.vocabularyJson()`,
`db.putVocabulary(heard, meant, source): String`, `db.deleteVocabulary(id)`,
`db.applyVocabularyToMeeting(id, punctuate: ((String) -> String)?, rules: List<Vocabulary.Rule> =
vocabularyRules()): Int`, `Vocabulary.Rule(heard, meant)`, `NativeBridge.ensureLoaded(ctx)`,
`NativeBridge.nativeApplySpokenPunctuation(text)`, `ModelCatalog.modelsDir(ctx)`.

**Files that must not change:** everything except `VerificationProbeTest.kt`, `device-verify.sh` (one
line), the report, the progress file. `VocabularyDbTest.kt` is read-only too: if an assertion fails,
report it (§6), do not bend the test. In particular `AudioDb.kt`: if a test
fails because of the code, stop and report — the code is reviewed and the test is what is new.

---

## 2. Implementation sequence

### Step 1 — `VocabularyDbTest` on the phone's real database

**1a.** `scripts/device-verify.sh`, in `CLASSES` directly after `com.innocorelabs.verbale.PeopleDbTest`:

```bash
  # Phase 5: correction rules and dictation marks over real utterances rows — text_raw kept once
  # and never overwritten, a rule replaced by its own `heard`, the mode column. Real SQLCipher and
  # the JNI seam, so not a JVM test.
  com.innocorelabs.verbale.VocabularyDbTest
```

**1b.** `android/app/src/androidTest/java/com/innocorelabs/verbale/VocabularyDbTest.kt` already exists — written and
compile-checked by the brain (`compileDebugAndroidTestKotlin` clean). Read it once (it is 132 lines);
do not edit it. For reference, this is the file:

```kotlin
package com.innocorelabs.verbale

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ModelCatalog
import com.innocorelabs.verbale.pipeline.NativeBridge
import com.innocorelabs.verbale.pipeline.Vocabulary
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Phase 5 (custom vocabulary, dictation) on the phone's real SQLCipher database: a rule corrects a
 * line and keeps the recogniser's wording in text_raw; a second pass never overwrites that wording;
 * a dictated meeting's spoken marks become marks through the JNI; the mode round-trips.
 *
 * The rule's `heard` is a word no real recording contains ("zorp co"), and every meeting and rule
 * this test makes is deleted after — the developer's own vocabulary is neither read into the
 * assertions (rules are passed explicitly) nor touched.
 */
@RunWith(AndroidJUnit4::class)
class VocabularyDbTest {
  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
  private val db = AudioDb.get(ctx)
  private val meetings = ArrayList<String>()
  private val rules = ArrayList<String>()

  @After fun cleanUp() {
    meetings.forEach { db.deleteMeeting(it) }
    rules.forEach { db.deleteVocabulary(it) }
  }

  private fun meeting(vararg texts: String): String {
    val id = "vocabdb-" + System.nanoTime()
    db.insertMeeting(id, "VocabularyDb test", System.currentTimeMillis(), "pro", "/dev/null")
    meetings.add(id)
    val arr = JSONArray()
    texts.forEachIndexed { i, t ->
      arr.put(JSONObject().put("start_ms", i * 3000L).put("end_ms", i * 3000L + 2000).put("text", t))
    }
    db.replaceUtterancesJson(id, arr.toString())
    return id
  }

  private fun rule(heard: String, meant: String, source: String): String =
    db.putVocabulary(heard, meant, source).also { if (it !in rules) rules.add(it) }

  /** (text, text_raw) per line in time order; text_raw null means the recogniser's wording stands. */
  private fun lines(id: String): List<Pair<String, String?>> {
    val arr = JSONArray(db.rawQueryJson(
      "SELECT text, text_raw FROM utterances WHERE meeting_id=? ORDER BY start_ms", arrayOf(id),
    ))
    return (0 until arr.length()).map { i ->
      val o = arr.getJSONObject(i)
      o.getString("text") to (if (o.isNull("text_raw")) null else o.getString("text_raw"))
    }
  }

  private fun rowsFor(heard: String): JSONArray =
    JSONArray(db.rawQueryJson("SELECT id, meant, source, uses FROM vocabulary WHERE heard=? COLLATE NOCASE", arrayOf(heard)))

  @Test fun rules_apply_and_keep_the_raw_wording() {
    val id = meeting("we sold it to zorp co", "nothing here")
    val rid = rule("zorp co", "Zorp", "typed")
    assertTrue("vocabularyRules() must read the row back", db.vocabularyRules().any { it.heard == "zorp co" && it.meant == "Zorp" })
    assertTrue("vocabularyJson() must carry the row", db.vocabularyJson().contains("\"heard\":\"zorp co\""))
    val mine = listOf(Vocabulary.Rule("zorp co", "Zorp"))

    assertEquals(1, db.applyVocabularyToMeeting(id, null, mine))
    assertEquals(
      listOf("we sold it to Zorp" to "we sold it to zorp co", "nothing here" to null),
      lines(id),
    )
    assertEquals(1, rowsFor("zorp co").getJSONObject(0).getInt("uses"))

    // A second pass changes nothing and — the point of COALESCE — leaves text_raw as it was.
    assertEquals(0, db.applyVocabularyToMeeting(id, null, mine))
    assertEquals("we sold it to zorp co", lines(id)[0].second)

    // Typing "ZORP CO" over an existing "zorp co" replaces its meant and source: one row, same id.
    assertEquals(rid, rule("ZORP CO", "Zorp Ltd", "learned"))
    val row = rowsFor("zorp co")
    assertEquals(1, row.length())
    assertEquals("Zorp Ltd", row.getJSONObject(0).getString("meant"))
    assertEquals("learned", row.getJSONObject(0).getString("source"))
    // Rules run over the CURRENT text, so a line already corrected to "Zorp" is not re-corrected by
    // a rule whose heard is "zorp co" — it already reads "Zorp". text_raw still holds the original.
    assertEquals(0, db.applyVocabularyToMeeting(id, null, listOf(Vocabulary.Rule("zorp co", "Zorp Ltd"))))
    assertEquals("we sold it to Zorp" to "we sold it to zorp co", lines(id)[0])
  }

  @Test fun dictation_applies_the_marks_and_keeps_raw() {
    val ort = File(ModelCatalog.modelsDir(ctx), "libonnxruntime.so")
    assumeTrue("libonnxruntime.so not downloaded yet on this device", ort.exists())
    NativeBridge.ensureLoaded(ctx)
    val id = meeting("tell finance comma the invoice is late full stop")
    db.setMode(id, "dictation")
    val punctuate = { t: String -> NativeBridge.nativeApplySpokenPunctuation(t) }
    assertEquals(1, db.applyVocabularyToMeeting(id, punctuate, emptyList()))
    assertEquals(
      listOf("Tell finance, the invoice is late." to "tell finance comma the invoice is late full stop"),
      lines(id),
    )
    assertEquals(0, db.applyVocabularyToMeeting(id, punctuate, emptyList()))
  }

  @Test fun mode_round_trips() {
    val id = meeting("one")
    assertNull(db.mode(id))
    db.setMode(id, "dictation")
    assertEquals("dictation", db.mode(id))
    db.setMode(id, null)
    assertNull(db.mode(id))
  }

  @Test fun put_rejects_blank_and_unknown_source() {
    try { db.putVocabulary(" ", "x", "typed"); fail("blank heard must throw") } catch (e: IllegalArgumentException) {}
    try { db.putVocabulary("x", " ", "typed"); fail("blank meant must throw") } catch (e: IllegalArgumentException) {}
    try { db.putVocabulary("x", "y", "guessed"); fail("unknown source must throw") } catch (e: IllegalArgumentException) {}
    assertEquals(0, rowsFor("x").length())
  }
}
```

**1c.** Run: `scripts/device-verify.sh VocabularyDbTest > /tmp/dv.log 2>&1; grep -E "^==>|OK \(|FAILURES|test=|Failure|BUILD" /tmp/dv.log | tail -14`
→ the four `test=` lines and `OK (4 tests)`. (The first run builds both APKs: 3–6 minutes. A
`FAILURES` line: read `grep -A 12 "stack=" /tmp/dv.log | head -40`, then §6.)

*Mutant (device):* in `AudioDb.applyVocabularyToMeeting` change `text_raw=COALESCE(text_raw, ?)` to
`text_raw=?` → re-run the class → `rules_apply_and_keep_the_raw_wording` fails at the assertion after
the second pass (text_raw becomes "we sold it to Zorp"). Restore the line, re-run → `OK (4 tests)`.
Record both runs in the progress file.

Commit: `test(vocab): VocabularyDbTest in device-verify CLASSES — 4/4 on the Pixel`.

### Step 2 — the seam test Session 1 wrote

No code. Run: `scripts/device-verify.sh NativePipelineTest > /tmp/dv2.log 2>&1; grep -E "OK \(|FAILURES|Tests run|spoken_punctuation" /tmp/dv2.log | tail -5`
→ `test=the_spoken_punctuation_crosses_the_jni_seam` appears and `OK (18 tests)`. If the line reads
`OK (18 tests)` but `grep -c "skipped" /tmp/dv2.log` is not `0`, `libonnxruntime.so` is missing on
the phone: record it as "skipped — model not downloaded" and continue; do not download anything.
Tick Step 2 in the progress file with the exact `OK (…)` line; commit.

### Step 3 — the probe prints the mode, the rules and the raw lines

`VerificationProbeTest.kt`. In the `SELECT … FROM meetings` string add `, mode` after `template_source`.
In the `println("PROBE meeting …` line, after `template_source=${m.opt("template_source")}` add
` mode=${m.opt("mode")}` (inside the string). Replace the `utterances` println with

```kotlin
      val utts = db.utterances(id)
      println("PROBE   utterances (${utts.size}): " + utts.take(12).joinToString(" | ") { "${it.startMs / 1000}s ${it.speakerId ?: "?"}: ${it.text}" })
      // Phase 5: which of the first lines a rule or a spoken mark rewrote (text_raw kept).
      val raw = JSONArray(db.rawQueryJson(
        "SELECT text_raw IS NOT NULL AS rewritten FROM utterances WHERE meeting_id=? ORDER BY start_ms LIMIT 6",
        arrayOf(id),
      ))
      println("PROBE   rewritten: " + (0 until raw.length()).joinToString(",") { raw.getJSONObject(it).getInt("rewritten").toString() })
```

After `println("PROBE people count: ${db.peopleCount()}")` add

```kotlin
    // Phase 5: the vocabulary, whole — it is small and it is the thing a by-hand run changes.
    val vocab = JSONArray(db.rawQueryJson("SELECT heard, meant, source, uses FROM vocabulary ORDER BY created_at", arrayOf()))
    println("PROBE vocabulary (${vocab.length()}): $vocab")
```

Run (the APKs from Step 1 are installed; this rebuilds and reinstalls the test APK only):
`scripts/device-verify.sh VocabularyDbTest > /tmp/dv3.log 2>&1; grep -E "OK \(|FAILURES" /tmp/dv3.log | tail -2` → `OK (4 tests)`; then
`~/Library/Android/sdk/platform-tools/adb shell am instrument -w -r -e class com.innocorelabs.verbale.VerificationProbeTest com.innocorelabs.verbale.test/androidx.test.runner.AndroidJUnitRunner 2>&1 | grep -E "PROBE (meeting|vocabulary|  rewritten)" | head -12`
→ every `PROBE meeting` line ends in `mode=null` or `mode=dictation`; one `PROBE vocabulary (N)` line;
a `rewritten:` line per meeting. Paste those lines into the progress file under *Notes* (they are
what the founder's by-hand run is read against).

Commit: `test(vocab): the probe prints mode, the vocabulary and which lines were rewritten`.

### Step 4 — the gate with its device stage, the report, the hand-over

**4a.** `bash scripts/gate.sh > /tmp/gate.log 2>&1; grep -E "^==>|ok |FAIL|all clear|skipped|device tests" /tmp/gate.log`
→ seven stages `ok`, the device stage naming `36091FDH30034G`, `gate: all clear`. A stage failing
in a file this session did not touch: §6.

**4b.** The report `docs/superpowers/reports/2026-09-21-phase-5-vocabulary-and-dictation.md`:
- §1 Status: add one sentence — "Session 3 (device, <date>): VocabularyDbTest 4/4 on the Pixel,
  NativePipelineTest <the OK line>, the probe extended, the gate clear with its device stage."
- §6 Device: replace the "Not run" paragraph with what the device showed — a line per class with
  its exact `OK (…)` count, the device mutant and its failing assertion, and the probe's lines.
- §8 Known gaps: remove nothing that is still true; add nothing unless Step 1–3 found it.
- §9 Commits: append this session's.
- Under §3 Decisions add: "Session 3: a rule whose `meant` is changed does not re-correct lines a
  previous pass already corrected (rules run over the current text; `text_raw` is a record, not a
  source) — pinned by `rules_apply_and_keep_the_raw_wording`. ⚑ To make Change retroactive within a
  meeting, `applyVocabularyToMeeting` would apply rules to `COALESCE(text_raw, text)` instead."

**4c.** `git rm docs/superpowers/reports/phase-5-progress.md` — the report now holds its Decisions,
Mutants and device lines. Commit: `docs(phase5): device session — VocabularyDbTest and the probe on
the Pixel; progress file retired`. `git status` clean. **Stop.**

---

## 3. Expected state after this session

- `scripts/device-verify.sh` CLASSES has `VocabularyDbTest` after `PeopleDbTest`; the class passes 4/4 on the Pixel.
- `VerificationProbeTest` prints `mode=`, `rewritten:` and `PROBE vocabulary (N)`.
- The report's §6 is written from the device; the progress file is gone.

## 4. Exact tests and commands

| Step | Command | Must show |
|---|---|---|
| 1 | `scripts/device-verify.sh VocabularyDbTest …` | `OK (4 tests)` |
| 1 | the same after the COALESCE mutant | `FAILURES!!!` naming `rules_apply_and_keep_the_raw_wording`; then `OK (4 tests)` restored |
| 2 | `scripts/device-verify.sh NativePipelineTest …` | `OK (18 tests)` |
| 3 | `am instrument … VerificationProbeTest \| grep PROBE` | `mode=`, `rewritten:`, `PROBE vocabulary (` |
| 4 | `bash scripts/gate.sh` | `gate: all clear`, device stage on `36091FDH30034G` |

## 5. Acceptance criteria

- §4 green; the device mutant recorded with both runs.
- `git diff --stat <the commit this sheet was committed in>..HEAD` names only: `VerificationProbeTest.kt`,
  `device-verify.sh`, the report, the progress file (deleted).
- `git status` clean.

## 6. Stop conditions

- Phone absent at the first command: write the note, commit, stop. Never wait more than ten minutes.
- A VocabularyDbTest assertion fails and the cause is in `AudioDb.kt`: do not change `AudioDb.kt`;
  record the failing assertion and the row values (`lines(id)` output from the stack), commit, report.
- Two unsuccessful fixes of the same failure: stop, record both, commit, report.
- A gate stage fails in a file you did not touch: do not investigate; record 20 lines, commit, report.
- 150 steps: finish the step, commit, stop.
