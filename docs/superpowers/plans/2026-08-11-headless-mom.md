# Headless MOM (Auto-process on PiP/notification stop + native minutes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a recording is stopped from the PiP window or the notification (not the in-app button), the meeting is automatically transcribed AND its minutes (the "MOM") are generated entirely in the background — no app reopen — and a "Notes ready" notification is posted.

**Architecture:** Today the native `ProcessingService`/`ProcessingEngine` run VAD→ASR→diarize, but the minutes ("MOM") are generated in JS (`PipelineController.buildMinutes`→`extractMinutes`), which only runs when the app UI is open (RecordScreen stop, or the Library-focus sweep). And stopping from PiP/notification (`PipActionReceiver`/`RecordingService` → `CaptureController.stop()`) never triggers processing at all. This plan (1) ports the deterministic rule-based minutes extractor to Kotlin so `ProcessingEngine` produces the MOM itself and marks the meeting `done`, (2) auto-enqueues processing when capture ends from PiP/notification, and (3) posts a "Notes ready" notification on completion. The LLM enhancement (best-effort, `summarize.ts`) stays in JS for the in-app path and is a documented follow-up for headless.

**Tech Stack:** Kotlin (regex port, foreground service, SQLCipher via `AudioDb`, `NotificationCompat`), JUnit for the ported extractor, existing JNI/`ProcessingEngine`, TypeScript reconciliation in `PipelineController`.

---

## Design decisions (locked)

- **Native becomes the source of truth for the full pipeline including rule-based minutes + `status='done'`.** Every processing path (in-app stop, PiP stop, notification stop, Library sweep) flows through `ProcessingEngine`, which now ends by writing minutes, retitling, applying retention, and setting `done`.
- **Rule-based minutes ported to Kotlin** (`minutes.ts` → `MinutesExtractor.kt`) — pure regex/keyword heuristics, no JS-only deps; a JUnit test mirrors `__tests__/minutes.test.ts` for parity.
- **LLM enhancement (`summarize.ts`) stays JS**, best-effort, in-app only, for now. Headless meetings get the rule-based MOM (the visible gist/actions/decisions). Porting the LLM orchestration to native is a follow-up.
- **HeadlessJS rejected** — technically works under bridgeless RN 0.86 but re-introduces the "JS might be gone" fragility this branch removed; native port keeps the guarantee.

## File Structure

**Create:**
- `android/app/src/main/java/com/audionotes/pipeline/MinutesExtractor.kt` — pure Kotlin port of `src/pipeline/minutes.ts`'s `extractMinutes(utterances, speakers): List<DraftMinute>`. No Android deps. `DraftMinute(kind, content, source="rule")`.
- `android/app/src/test/java/com/audionotes/pipeline/MinutesExtractorTest.kt` — JUnit parity tests mirroring `__tests__/minutes.test.ts`.

**Modify:**
- `android/app/src/main/java/com/audionotes/data/AudioDb.kt` — add `replaceMinutes(meetingId, rows)` (mirror `replaceUtterancesJson`'s DELETE+INSERT transaction), `setTitle(meetingId, title)`, `getSetting(key)` (if not present — needed for retention `keepAudio`), and a title read for the retitle guard. Confirm exact minutes schema: `minutes(id, meeting_id, kind, content_json, source)`.
- `android/app/src/main/java/com/audionotes/pipeline/ProcessingEngine.kt` — after diarize (and whenever a transcript exists), run a new **minutes stage**: build rule-based minutes via `MinutesExtractor`, retitle from the transcript, write minutes + title via `AudioDb`, apply audio retention, then `setStatus(meetingId, "done")` before `onComplete("done")`.
- `android/app/src/main/java/com/audionotes/pipeline/PipActionReceiver.kt` — capture `CaptureController.stop()`'s returned id and `ProcessingService.enqueue(context, id)`.
- `android/app/src/main/java/com/audionotes/pipeline/RecordingService.kt` — same auto-enqueue in the notification `ACTION_STOP` handler.
- `android/app/src/main/java/com/audionotes/pipeline/ProcessingService.kt` — post a "Notes ready" notification (new channel `audionotes.done`, `IMPORTANCE_DEFAULT`, tap-opens the meeting) when a run finishes with outcome `done`.
- `src/pipeline/PipelineController.ts` — reconcile: `process()` no longer calls `buildMinutes`/retitle/retention (native does them); it awaits completion then runs `enhanceMinutes` (LLM, in-app best-effort) only. `sweep()` re-enqueues pending meetings through `process()` (drop the JS `buildMinutes`-direct branch, since native now finishes them to `done`).

---

## Task 1: `AudioDb` native writes — `replaceMinutes`, `setTitle`, `getSetting`

**Files:**
- Modify: `android/app/src/main/java/com/audionotes/data/AudioDb.kt`

- [ ] **Step 1: Read the existing patterns.** Read `replaceUtterancesJson` (`~:186-216`), `assignSpeakers`, `replaceSegments` for the DELETE+INSERT-in-transaction idiom and the `db` field usage; read the `minutes` table DDL (`minutes(id, meeting_id, kind, content_json, source)`), and confirm whether `getSetting`/`setTitle` already exist (JS uses generic passthrough; native may not have typed methods).

- [ ] **Step 2: Add the methods.** Add (adapting names/idiom to the file):

```kotlin
/** Replace all minutes rows for a meeting in one transaction (mirrors replaceUtterancesJson). */
fun replaceMinutes(meetingId: String, rows: List<com.audionotes.pipeline.DraftMinute>) {
  db.beginTransaction()
  try {
    db.execSQL("DELETE FROM minutes WHERE meeting_id = ?", arrayOf(meetingId))
    val stmt = db.compileStatement(
      "INSERT INTO minutes(id, meeting_id, kind, content_json, source) VALUES (?,?,?,?,?)")
    for (r in rows) {
      stmt.clearBindings()
      stmt.bindString(1, java.util.UUID.randomUUID().toString())
      stmt.bindString(2, meetingId)
      stmt.bindString(3, r.kind)
      stmt.bindString(4, r.content)   // content_json stores a plain string, aliased 'content' in JS
      stmt.bindString(5, r.source)
      stmt.executeInsert()
    }
    db.setTransactionSuccessful()
  } finally { db.endTransaction() }
}

/** Overwrite the meeting title (only the pipeline's own generated title, guarded by the caller). */
fun setTitle(meetingId: String, title: String) {
  db.execSQL("UPDATE meetings SET title = ? WHERE id = ?", arrayOf(title, meetingId))
}

/** Read a settings value (e.g. keepAudio) for native retention decisions. Returns null if absent. */
fun getSetting(key: String): String? =
  db.rawQuery("SELECT value FROM settings WHERE key = ? LIMIT 1", arrayOf(key)).use {
    if (it.moveToFirst()) it.getString(0) else null
  }
```

> Confirm the settings table/columns (`settings(key, value)`?) by reading how JS `getSetting`/`setSetting` map in `queries.ts`. Confirm the meetings title column is `title`. If `getSetting`/`setTitle` already exist natively, reuse them.

- [ ] **Step 3: Compile.** `cd android && ./gradlew :app:compileDebugKotlin` → BUILD SUCCESSFUL. (`DraftMinute` doesn't exist yet — either land Task 2 first, or temporarily type `rows` as `List<Triple<String,String,String>>`; simplest is to do Task 2 first, so REORDER: implement Task 2 before this step compiles. Sequence: Task 2 then Task 1.)

- [ ] **Step 4: Commit.**
```bash
git add android/app/src/main/java/com/audionotes/data/AudioDb.kt
git commit -m "feat(db): native replaceMinutes/setTitle/getSetting for headless minutes"
```
End every commit message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

## Task 2: Port the rule-based minutes extractor to Kotlin — TDD

**Files:**
- Create: `android/app/src/main/java/com/audionotes/pipeline/MinutesExtractor.kt`
- Test: `android/app/src/test/java/com/audionotes/pipeline/MinutesExtractorTest.kt`

Port `src/pipeline/minutes.ts` faithfully. Data types:
```kotlin
data class DraftMinute(val kind: String, val content: String, val source: String = "rule")
// kind in: "summary" | "decision" | "action" | "question"
data class Utt(val text: String, val speakerId: String?)   // minimal input the extractor needs
data class Spk(val id: String, val displayName: String?)
```
`MinutesExtractor.extract(utterances: List<Utt>, speakers: List<Spk>): List<DraftMinute>`.

- [ ] **Step 1: Write the failing tests** — mirror `__tests__/minutes.test.ts`. READ that file first and translate each case. Cover at minimum: a decision ("we decided to ship…" → a `decision` minute), an action with a named owner + due date ("Priya will finalize the release notes by Thursday" → `action`, content includes owner + "(due …)"), a question ("should we …?" → `question`), the synthetic `summary` count line first, dedup of repeated sentences, and the per-kind caps. Example shape:

```kotlin
package com.audionotes.pipeline
import org.junit.Assert.*
import org.junit.Test

class MinutesExtractorTest {
  private fun u(t: String, s: String? = "s1") = Utt(t, s)

  @Test fun detectsDecision() {
    val out = MinutesExtractor.extract(listOf(u("We decided to ship version 2.1 on Friday.")), emptyList())
    assertTrue(out.any { it.kind == "decision" && it.content.contains("2.1") })
  }
  @Test fun detectsActionWithOwnerAndDue() {
    val out = MinutesExtractor.extract(listOf(u("Priya will finalize the release notes by Thursday.")), emptyList())
    val a = out.firstOrNull { it.kind == "action" }
    assertNotNull(a); assertTrue(a!!.content.contains("Priya")); assertTrue(a.content.contains("due"))
  }
  @Test fun detectsQuestion() {
    val out = MinutesExtractor.extract(listOf(u("Should we delay the launch?")), emptyList())
    assertTrue(out.any { it.kind == "question" })
  }
  @Test fun firstMinuteIsSummaryCount() {
    val out = MinutesExtractor.extract(listOf(u("We approved it. David will send the plan tomorrow.")), emptyList())
    assertEquals("summary", out.first().kind)
  }
  // ... translate the remaining minutes.test.ts cases (dedup, caps, imperative-start, first-person owner)
}
```

- [ ] **Step 2: Run tests, verify they fail.** `cd android && ./gradlew :app:testDebugUnitTest --tests "com.audionotes.pipeline.MinutesExtractorTest"` → FAIL (unresolved).

- [ ] **Step 3: Implement `MinutesExtractor.kt`** by porting `minutes.ts` line-for-line. Port these constants/functions faithfully (all regex features used are Java/Kotlin-compatible, incl. the fixed-width lookbehind `(?<=[.!?])\s+`):
  - `splitSentences` (split on `(?<=[.!?])\s+`), `norm` (lowercase, strip non-alphanumeric) for dedup keys.
  - `DECISION`, `QUESTION_WORDS`, `ACTION_FIRST_PERSON`, `ACTION_ASSIGN`, `ACTION_OBLIGATION`, imperative verb list, `NAMED_OWNER`, `DUE` regexes — copy the exact patterns from `minutes.ts` (use `RegexOption.IGNORE_CASE` where the JS uses `/i`).
  - Classification priority per sentence: question → decision → action; owner detection (named → first-person speaker displayName → "Unassigned"); due-date append `— Owner (due X)`.
  - Dedup via a `MutableSet<String>` of normalized keys; caps 30 actions / 20 decisions / 20 questions; prepend a synthetic `summary` "N action items, M decisions, K open questions." line; final order `[summary, decisions…, actions…, questions…]`.
  Match the exact `summary` wording and the `— Owner (due X)` formatting to `minutes.ts` so the UI reads identically.

- [ ] **Step 4: Run tests, verify pass.** Same gradle command → PASS. Add `testImplementation("junit:junit:4.13.2")` to `app/build.gradle` only if not already present (Task 1 of the background-processing work already added it).

- [ ] **Step 5: Commit.**
```bash
git add android/app/src/main/java/com/audionotes/pipeline/MinutesExtractor.kt \
        android/app/src/test/java/com/audionotes/pipeline/MinutesExtractorTest.kt
git commit -m "feat(pipeline): port rule-based minutes extractor to Kotlin (parity with minutes.ts)"
```

---

## Task 3: `ProcessingEngine` — generate the MOM natively after diarize

**Files:**
- Modify: `android/app/src/main/java/com/audionotes/pipeline/ProcessingEngine.kt`

After the diarize stage (and on any path where a transcript now exists), add a minutes stage before `onComplete("done")`. It must run whether diarize produced speakers or not, as long as there are utterances.

- [ ] **Step 1: Add the minutes stage.** In `run()`, after the DIARIZE block and before the final `listener.onComplete("done")`, insert:

```kotlin
// ---- Minutes / MOM (rule-based, native) + retitle + retention + done ----
val utts = db.utterances(meetingId)            // add AudioDb.utterances(meetingId) read if absent
if (utts.isNotEmpty()) {
  val speakers = db.speakers(meetingId)         // add AudioDb.speakers read if absent
  val minutes = MinutesExtractor.extract(
    utts.map { Utt(it.text, it.speakerId) },
    speakers.map { Spk(it.id, it.displayName) },
  )
  db.replaceMinutes(meetingId, minutes)
  retitleFromTranscript(meetingId, utts)        // port of PipelineController.retitleFromTranscript
  applyRetention(meetingId, utts.size)          // discard audio if keepAudio != "1" and transcript exists
  db.setStatus(meetingId, "done")
  Log.i(TAG, "Minutes produced ${minutes.size} items for $meetingId")
}
listener.onComplete("done")
```

> Add small private helpers in `ProcessingEngine` (or a `NativeMinutes` object): `retitleFromTranscript` — port `PipelineController.ts:223-249` (only overwrite a title equal to "Meeting" or matching ` meeting · `; take the opening ≤60 chars cut at a sentence/word boundary, capitalize). `applyRetention` — if `db.getSetting("keepAudio") != "1"` and utterance count > 0, delete the audio file (reuse the existing native discard logic; `AudioPipelineModule.discardAudio` shows the file-delete + `setAudioRetained(false)` pattern — extract a shared helper or replicate).
> You will need `AudioDb.utterances(meetingId)` and `AudioDb.speakers(meetingId)` reads that return the fields the extractor needs (text, speakerId; id, displayName). Add them if not present, mirroring `queries.ts`'s columns.

- [ ] **Step 2: Build.** `./gradlew :app:assembleDebug` → BUILD SUCCESSFUL.

- [ ] **Step 3: Device smoke (controller will run).** After Task 4/5, verify a fresh recording processed by the service reaches `done` with minutes visible WITHOUT opening via the Library sweep. (Implementer: just confirm compile; controller device-tests.)

- [ ] **Step 4: Commit.**
```bash
git add android/app/src/main/java/com/audionotes/pipeline/ProcessingEngine.kt \
        android/app/src/main/java/com/audionotes/data/AudioDb.kt
git commit -m "feat(pipeline): ProcessingEngine builds minutes + retitles + retention + done (headless MOM)"
```

---

## Task 4: Auto-enqueue processing when capture ends from PiP/notification

**Files:**
- Modify: `android/app/src/main/java/com/audionotes/pipeline/PipActionReceiver.kt`
- Modify: `android/app/src/main/java/com/audionotes/pipeline/RecordingService.kt`

`CaptureController.stop(context): String?` returns the stopped meetingId. Both stop paths currently discard it.

- [ ] **Step 1: PipActionReceiver STOP.** In the `ACTION_STOP` branch's worker thread, capture the id and enqueue:
```kotlin
val id = CaptureController.stop(context.applicationContext)
if (id != null) {
  try { ProcessingService.enqueue(context.applicationContext, id) }
  catch (e: Exception) { Log.w(TAG, "auto-enqueue after PiP stop failed for $id", e) }
}
```
(The try/catch guards the documented `ForegroundServiceStartNotAllowedException`; a PiP-button tap is a user-initiated FGS-start exemption, but be defensive. If it fails, the Library sweep still processes it later.)

- [ ] **Step 2: RecordingService notification STOP.** In the notification `ACTION_STOP` handler's thread (`~:105-114`), same pattern: capture `CaptureController.stop(applicationContext)`'s id and `ProcessingService.enqueue(applicationContext, id)` (guarded), before/after `stopSelfSafely()` as appropriate.

- [ ] **Step 3: Build.** `./gradlew :app:assembleDebug` → BUILD SUCCESSFUL.

- [ ] **Step 4: Commit.**
```bash
git add android/app/src/main/java/com/audionotes/pipeline/PipActionReceiver.kt \
        android/app/src/main/java/com/audionotes/pipeline/RecordingService.kt
git commit -m "feat(pipeline): auto-enqueue processing when capture ends from PiP/notification"
```

---

## Task 5: "Notes ready" notification on completion

**Files:**
- Modify: `android/app/src/main/java/com/audionotes/pipeline/ProcessingService.kt`

- [ ] **Step 1: Post a terminal notification.** In the `ProcessingEngine.Listener.onComplete` wiring inside `runLoop` (`~:84-86`), when `outcome == "done"`, post a "Notes ready" notification on a NEW channel (so it isn't torn down with the ongoing foreground notification):

```kotlin
override fun onComplete(outcome: String, message: String?) {
  AudioPipelineBridge.emitComplete(id, outcome, message)
  if (outcome == "done") postNotesReady(id)
}
```
```kotlin
private fun postNotesReady(meetingId: String) {
  try {
    val chan = "audionotes.done"
    NotificationManagerCompat.from(this).createNotificationChannel(
      NotificationChannelCompat.Builder(chan, NotificationManagerCompat.IMPORTANCE_DEFAULT)
        .setName("Notes ready").build())
    // Tap opens the app to the meeting. Reuse the launcher intent + meetingId extra if MainActivity
    // reads it; otherwise a plain launch intent is fine for v1.
    val open = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      putExtra("openMeetingId", meetingId)
    }
    val pi = android.app.PendingIntent.getActivity(
      this, meetingId.hashCode(), open ?: Intent(),
      android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT)
    val n = NotificationCompat.Builder(this, chan)
      .setSmallIcon(applicationInfo.icon)  // or the same drawable RecordingService uses
      .setContentTitle("Your notes are ready")
      .setContentText("Tap to see the summary and transcript.")
      .setAutoCancel(true)
      .setContentIntent(pi)
      .build()
    NotificationManagerCompat.from(this).notify(meetingId.hashCode() and 0xffff, n)
  } catch (_: Exception) { /* POST_NOTIFICATIONS denied — non-fatal */ }
}
```

> Deep-linking to the specific meeting (reading `openMeetingId` in `MainActivity`/JS) is optional for v1 — a plain app-open is acceptable; note it as a follow-up if not wired. Use the same small icon the other notifications use.

- [ ] **Step 2: Build.** `./gradlew :app:assembleDebug` → BUILD SUCCESSFUL.

- [ ] **Step 3: Commit.**
```bash
git add android/app/src/main/java/com/audionotes/pipeline/ProcessingService.kt
git commit -m "feat(pipeline): post 'Notes ready' notification when background processing completes"
```

---

## Task 6: JS reconciliation — native owns minutes now

**Files:**
- Modify: `src/pipeline/PipelineController.ts`

Native now writes minutes + retitle + retention + `done`. JS must stop double-doing that, while keeping the best-effort LLM enhancement for the in-app path.

- [ ] **Step 1: `process()` — skip buildMinutes; keep enhance.**
```ts
async process(meetingId: string, opts: { model: 'base' | 'small'; useLLM: boolean }): Promise<void> {
  const outcome = await this.awaitNativeComplete(meetingId, () => AudioPipeline.process(meetingId, opts));
  if (outcome !== 'done') return;
  // Native already wrote the rule-based minutes, retitled, applied retention and set 'done'.
  // JS only adds the best-effort LLM upgrade when the app is open and the device is capable.
  if (opts.useLLM !== false) await this.enhanceMinutes(meetingId);
}
```

- [ ] **Step 2: `sweep()` — always re-enqueue through process().** Drop the `utt>0 && spk>0 → buildMinutes` shortcut branch (native now finishes pending meetings to `done`, so they won't be pending; and any still-pending meeting must run through native): the loop body becomes just `await this.process(m.id, { model: 'base', useLLM: true })` inside the existing `inFlight` guard.

- [ ] **Step 3: Keep `buildMinutes`/`extractMinutes`/`enhanceMinutes`/`finishMinutes` in the file** (still used by `enhanceMinutes`, and as reference/tests) but they are no longer on the main happy path. Do NOT delete `extractMinutes` — `__tests__/minutes.test.ts` and the Kotlin port both depend on it as the spec. If `finishMinutes` becomes unused after Steps 1–2, remove it to avoid dead code (confirm no other caller).

- [ ] **Step 4: Update tests.** `__tests__/sweep.test.ts` asserts the old buildMinutes-direct behavior — update it: a pending meeting now routes through `process()` (which calls `AudioPipeline.process`), not a direct `buildMinutes`. Adjust the assertions accordingly. Run `npx jest` and `npx tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 5: Commit.**
```bash
git add src/pipeline/PipelineController.ts __tests__/sweep.test.ts
git commit -m "refactor(pipeline): native owns minutes; JS only adds best-effort LLM enhance"
```

---

## Task 7: End-to-end device verification (controller)

- [ ] **Real-life PiP flow:** record in PiP over another app, **Stop from PiP**, keep using other apps — confirm `ProcessingService` auto-starts, notification steps stages, then a **"Notes ready"** notification appears, and the meeting is `done` with a real transcript + MOM — WITHOUT opening the app.
- [ ] **Notification stop:** same via the notification's Stop action.
- [ ] **In-app stop still works:** RecordScreen Stop → meeting → READY with minutes (and LLM enhance if capable).
- [ ] **Parity:** the native rule-based minutes match what JS produced before (spot-check gist/action/decision wording against a known transcript).
- [ ] **No double-processing / no regression** in the Library sweep for older pending meetings.

---

## Self-Review notes

- **Spec coverage:** auto-enqueue (Task 4) + native minutes (Tasks 1–3) + notification (Task 5) + JS reconciliation (Task 6) = the full headless MOM; device-verified in Task 7. ✅
- **Task ordering:** implement **Task 2 before Task 1's compile step** (`AudioDb.replaceMinutes` references `DraftMinute`). Then 3 → 4 → 5 → 6.
- **Parity risk:** the Kotlin extractor must match `minutes.ts` exactly (summary wording, owner/due formatting) or the MOM reads differently depending on path. Mirror `__tests__/minutes.test.ts` as JUnit and spot-check on device (Task 7).
- **LLM headless is out of scope** — headless meetings get the rule-based MOM; the LLM upgrade applies for in-app/`enhanceMinutes` only. Follow-up: port `summarize.ts` to native driving `NativeBridge.nativeLlmLoad/Generate/Free`.
- **Deep-link to meeting** from the "Notes ready" tap is optional for v1 (plain app-open acceptable); note as follow-up.
- **Open verification for the implementer:** exact `settings`/`minutes`/`meetings.title` column names in `AudioDb` (Task 1); whether `AudioDb.utterances/speakers` reads exist or must be added (Task 3); the small notification icon resource (Task 5).
