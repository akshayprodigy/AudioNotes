# Phase B — nothing is lost, and nothing false is said — execution sheet

*25 September 2026, against `1a23715`. For the two sessions that build it. Every file, anchor,
line number, string and rule below was grepped today. Do not design anything: where this sheet
names copy, a rule, a status or a column, it is the decided answer. The plan and to-do list:
`docs/superpowers/plans/2026-09-24-tier-1-fixes.md` (items B1–B6).*

**What is wrong today (all verified in the code):**

- **B1.** "Write it again" calls `onReprocess(true)` (`MeetingScreen.tsx:1218`), which runs
  `db.clearNarration` (deletes the LLM summary) BEFORE processing, and never passes `force`. A
  rewrite that cannot finish (Pro lapsed, model gone, killed for memory) leaves no summary. The
  safe path is built end to end (`PipelineController.process(id, { force: true })` →
  `ProcessingService` → `ResumePlan.remaining(state, forceNarrate)` → `Narrator` →
  `AudioDb.replaceMinutes`, one transaction). Choosing a meeting type on Pro rewrites without
  asking (`SummaryTab.tsx:296-302`), and does not wait for the new type to be saved first.
- **B2.** Only Stop from the screen, the notification or PiP sends a meeting for processing. The
  free limit (`RecordingService.kt:459-463`), a lost mic (`:423-427`), a full disk (`:465-469`) and
  the Quick Settings tile's Stop (`RecordTileService.kt:80`) do not — they wait for the Library to
  be opened. The reason is kept only in a log line (`:625`); the free-limit notice claims "is being
  transcribed" when nothing was queued. Any other exception in the capture loop (`:471-472`) leaves
  the service running with a dead recorder. A recorder that fails to open (`:301-310`) ends with no
  reason at all.
- **B3.** A crash (`ProcessingEngine.kt:470`) writes `status='error'`, the same value as "no
  speech", so the Library says NO SPEECH, the sweep (`queries.ts:438-442`) never retries it,
  "Clear empty recordings" (`queries.ts:137-141`) offers it for deletion, and Redo on a crash
  before VAD lands straight back on no speech (`ResumePlan.kt:44`).
- **B4.** An announcement that was silenced, not heard, or failed is only logged
  (`RecordingService.kt:384-386`); the meeting row cannot tell "not heard" from "switched off".
- **B5.** "Pip could not hear any speech" (`MeetingScreen.tsx:1172-1177`) is chosen by a 2-minute
  poll timeout, not by status (`:842-843`): a queued meeting, one waiting for a model, a crash, and
  one opened mid-pause all end up there.
- **B6.** The merge button on the Speakers screen (`SpeakersScreen.tsx:87-91`, `:170-176`) merges
  on one tap and deletes the dropped speaker; there is no way back.

**Decided:**

- New meeting status **`failed`** = processing crashed. `error` keeps meaning "no speech".
- Four new `meetings` columns: `end_reason TEXT`, `fail_reason TEXT`,
  `fail_count INTEGER NOT NULL DEFAULT 0`, `announce_outcome TEXT`.
- `end_reason` values: `stopped` (every Stop), `cap_reached`, `mic_lost`, `disk_full`,
  `write_failed`, `mic_unavailable`.
- The sweep retries a `failed` meeting until it has failed **3** times; after that only a person's
  Try again runs it.
- A recording that captured **0 bytes** is set to `error` at once and never queued.
- Every non-Stop ending with audio is queued from the service itself, in a try/catch (Android may
  refuse a background start); the notification says "It is being transcribed now." only when the
  queueing went through, otherwise "Open Verbale to transcribe it." Tapping it opens the app,
  whose Library sweep then processes it.
- "Announcement not heard" is a capture warning, ranked below storage and above loud/faint, shown
  for **2 minutes** of capture after the verdict, then gone. The meeting keeps the permanent record.
- Changing the type on Pro **over an existing summary** asks first; free (relabel only) and Pro
  with no summary yet do not ask.
- Merging speakers uses the existing `confirmDestructive` (`src/components/confirm.ts`).

**Two sessions.** Session B1 = Steps 1–5 plus 4b (data, crash status, endings, announcement, the clip kept out of ASR — native and
queries). Session B2 = Steps 6–10 (screens, gate, report). No device in either.

---

## 0. Rules

- **Token discipline.** Read only the files and line ranges in §1. Never print a file over 200
  lines; `grep -n` to locate, then `sed -n 'A,Bp'` for at most 60 lines. `RecordingService.kt`,
  `AudioDb.kt`, `ProcessingEngine.kt`, `MeetingScreen.tsx`, `LibraryScreen.tsx`,
  `RecordScreen.tsx`, `SummaryTab.tsx` are all over 500 lines: only the ranges named. Every command
  ends in its filter — run it exactly as written. Do not re-read a file after editing it. Do not
  paste code into your messages; commit it and name it.
- **Line numbers are as of `1a23715`.** An earlier step in your own session shifts them; re-locate
  with the grep given next to each anchor.
- **TDD + mutant.** Test first, watch it fail, write the code, watch it pass, apply the **named
  mutant**, watch the test fail, restore, green again. Record each mutant in the progress file as
  it happens. Never run a mutation-restore in the background.
- **Commit after each step**, subject in the house style (`git log --oneline -6`). **Never push.**
- **No device, no adb.** Never run `connectedDebugAndroidTest`, any `adb` command, or the bare
  `scripts/gate.sh`. The gate's stage variable is **`GATE_STAGES`** (not `STAGES`); use ONLY the
  form given in Steps 5 and 10.
- **Indent like the surrounding file**: two spaces in TS and Kotlin.
- **Progress file.** First action of Session B1: create
  `docs/superpowers/reports/phase-b-progress.md` with Steps 1, 2, 3, 4, 4b, 5–10 as checkboxes and headings
  *Decisions*, *Mutants*, *Notes for the next session*. Update and commit it with every step.
  Session B2 reads it first.
- **Hand-over at 150 steps**: finish the step you are on, commit, update the progress file, stop.
- **`git status` must be clean before you stop.**

---

## 1. Relevant files (the only files you read)

`K` = `android/app/src/main/java/com/innocorelabs/verbale`, `T` = `android/app/src/test/java/com/innocorelabs/verbale`.

| File | Lines | Why |
|---|---|---|
| `K/data/AudioDb.kt` | 525–530, 570–576, 687–689, 3146–3150, 3214–3219 | Steps 1, 2, 3, 4 |
| `T/SchemaTest.kt` | 265–290 | Step 1 |
| `src/db/schema.ts` | 22–62 | Step 1 |
| `src/db/__tests__/schema.test.ts` | 97–108 | Step 1 |
| `src/db/queries.ts` | 100–125, 130–141, 158–167, 430–443 | Step 1 |
| `src/pipeline/types.ts` | 1–18, 55–67 | Step 1 |
| `K/pipeline/ResumePlan.kt` | 38–52 | Step 2 |
| `T/pipeline/ResumePlanTest.kt` | 1–30 | Step 2 |
| `K/pipeline/ProcessingEngine.kt` | 464–472 | Step 2 |
| `K/pipeline/DeviceFit.kt` | 88–95 | Step 2 (the `CPU_REASON` constant only) |
| `K/pipeline/RecordingService.kt` | 58–63, 94–107, 272–311, 380–387, 420–428, 470–481, 612–643, 710–738, 830–838 | Steps 3, 4 |
| `K/pipeline/RecordTileService.kt` | 73–83 | Step 3 |
| `K/pipeline/CaptureWarnings.kt` | all (119) | Step 4 |
| `T/pipeline/CaptureWarningsTest.kt` | 1–20, 40–51 | Step 4 |
| `K/pipeline/CaptureController.kt` | 106–168 | Step 4 |
| `android/app/src/main/res/values/strings.xml` | 15–23 | Steps 3, 4 |
| `src/native/NativeAudioPipeline.ts` | 76–80 | Step 4 |
| `src/screens/MeetingScreen.tsx` | 90–103, 385–432, 836–844, 1130–1245 | Step 7 |
| `src/screens/__tests__/MeetingScreen.test.tsx` | 1–75, 450–470 | Step 7 |
| `src/screens/meeting/SummaryTab.tsx` | 1–20, 110–118, 138–145, 288–303 | Step 8 |
| `src/screens/meeting/__tests__/SummaryTab.test.tsx` | 1–75, 140–180 | Step 8 |
| `src/screens/LibraryScreen.tsx` | 42–95 | Step 9 |
| `src/screens/__tests__/LibraryScreen.test.tsx` | 1–100 | Step 9 |
| `src/screens/RecordScreen.tsx` | 60–85, 190–262 | Step 9 |
| `src/screens/SpeakersScreen.tsx` | 1–15, 76–92 | Step 9 |
| `src/screens/__tests__/SpeakersScreen.test.tsx` | 1–50 | Step 9 |

**Interfaces you use without reading their files:**
- `ProcessingService.enqueue(ctx: Context, meetingId: String, force: Boolean = false)` — throws
  when Android refuses a background start.
- `AnnouncementPlayer.Outcome { PLAYED, DISABLED, SILENCED, NOT_HEARD, NO_CLIP, FAILED }`, with
  `wasHeard()` true only for `PLAYED`.
- `DeviceFit.CPU_REASON: String` (a `const val`).
- `PipelineController.process(meetingId, { model: 'base', force?: boolean }): Promise<void>` —
  resolves on the native completion event.
- `confirmDestructive({ title, message, confirmLabel, onConfirm })` from `src/components/confirm`.
- `Button`, `SoftButton`, `Txt` from `src/components/ui`; icon names `'refresh'` and
  `'alert'` exist.
- The native `onStageComplete` event payload is `{ meetingId, outcome }`.

## 2. Files that must not change

- `K/pipeline/Narrator.kt`, `K/pipeline/ProcessingService.kt`, `K/pipeline/AnnouncementPlayer.kt`,
  `K/pipeline/AnnouncementVerifier.kt`, `K/pipeline/AudioPipelineModule.kt`,
  `K/data/BackupManager.kt`, `K/pipeline/PipActionReceiver.kt`.
- `src/pipeline/PipelineController.ts`, `src/components/confirm.ts`, `src/state/recordingStore.ts`,
  `src/billing/*`, `server/*`.

---

## 3. Implementation sequence

### Session B1 — data, crash status, endings, announcement

#### Step 1. Four columns, the `failed` status, and the sweep that retries it

**Tests first.**

1. `T/SchemaTest.kt`: rename `meetingsHasTheSameTwentyTwoColumnsAsTheJavaScriptMirror` to
   `meetingsHasTheSameTwentySixColumnsAsTheJavaScriptMirror`; after `"mode",` in `expected` add:
   ```kotlin
      "end_reason",
      "fail_reason",
      "fail_count",
      "announce_outcome",
   ```
2. `src/db/__tests__/schema.test.ts` line 105: after `'template_source', 'mode',` add
   `'end_reason', 'fail_reason', 'fail_count', 'announce_outcome',` inside the same array.
3. New file `src/db/__tests__/pendingMeetings.test.ts`:
   ```ts
   import { DatabaseSync } from 'node:sqlite';
   import { SCHEMA } from '../schema';
   import { EMPTY_MEETINGS_SQL, PENDING_MEETINGS_SQL } from '../queries';

   /**
    * The two library-wide queries that decide a meeting's fate by status, run against the real
    * DDL: the sweep that processes what is unfinished, and the "empty recordings" list that
    * deletes. A crash (`failed`) belongs to the first and must never reach the second.
    */
   function freshDb(): DatabaseSync {
     const db = new DatabaseSync(':memory:');
     for (const t of ['meetings', 'utterances']) {
       const ddl = SCHEMA.find(s => s.trimStart().startsWith(`CREATE TABLE IF NOT EXISTS ${t} (`));
       if (!ddl) throw new Error(`no ${t} in SCHEMA`);
       db.exec(ddl);
     }
     return db;
   }

   function add(db: DatabaseSync, id: string, status: string, createdAt: number, failCount = 0) {
     db.prepare('INSERT INTO meetings(id, title, created_at, status, fail_count) VALUES (?,?,?,?,?)')
       .run(id, id, createdAt, status, failCount);
   }

   const ids = (db: DatabaseSync, sql: string) =>
     (db.prepare(sql).all() as { id: string }[]).map(r => r.id);

   test('the sweep picks up unfinished and failed meetings, oldest first', () => {
     const db = freshDb();
     add(db, 'captured', 'captured', 1);
     add(db, 'vad', 'vad', 2);
     add(db, 'failed', 'failed', 3);
     add(db, 'done', 'done', 4);
     add(db, 'error', 'error', 5);
     add(db, 'recording', 'recording', 6);
     expect(ids(db, PENDING_MEETINGS_SQL)).toEqual(['captured', 'vad', 'failed']);
   });

   test('a meeting that failed three times is left for a person to retry', () => {
     const db = freshDb();
     add(db, 'twice', 'failed', 1, 2);
     add(db, 'thrice', 'failed', 2, 3);
     expect(ids(db, PENDING_MEETINGS_SQL)).toEqual(['twice']);
   });

   test('a crashed meeting is never offered for deletion as an empty recording', () => {
     const db = freshDb();
     add(db, 'silent', 'error', 1);
     add(db, 'crashed', 'failed', 2);
     expect(ids(db, EMPTY_MEETINGS_SQL)).toEqual(['silent']);
   });
   ```
4. Run `npx jest src/db --silent 2>&1 | grep -E "Tests:|✕" | tail -8` → fails (no exports, no
   columns). `cd android && ./gradlew :app:testDebugUnitTest --tests '*SchemaTest*' 2>&1 | grep -E "BUILD|FAILED" | tail -3` → FAILED.

**Code.**

5. `K/data/AudioDb.kt`, in `ADDED_COLUMNS` after `Triple("meetings", "mode", "TEXT"),` (line 3216,
   grep `Triple("meetings", "mode"`):
   ```kotlin
      // Phase B: how the recording ended — 'stopped' for every Stop, else the reason the service
      // ended it (cap_reached, mic_lost, disk_full, write_failed, mic_unavailable). NULL on meetings
      // recorded before it existed.
      Triple("meetings", "end_reason", "TEXT"),
      // Phase B: status 'failed' is a crash, not silence. This is the sentence the person sees, and
      // fail_count is how many runs crashed — the sweep stops retrying at 3.
      Triple("meetings", "fail_reason", "TEXT"),
      Triple("meetings", "fail_count", "INTEGER NOT NULL DEFAULT 0"),
      // Phase B: AnnouncementPlayer.Outcome, lowercased, for every new recording — so a meeting can
      // say "not announced" and why, which announced_at (set only when heard) cannot.
      Triple("meetings", "announce_outcome", "TEXT"),
   ```
6. `src/db/schema.ts`: replace the last two lines of the `meetings` CREATE TABLE
   (`     -- Phase 5: 'dictation' …` and `     mode TEXT`) with:
   ```ts
        -- Phase 5: 'dictation' for a meeting recorded in dictation mode; NULL is an ordinary meeting.
        mode TEXT,
        end_reason TEXT,              -- 'stopped' or why the service ended it (cap_reached, mic_lost…)
        fail_reason TEXT,             -- status 'failed': the sentence the person sees
        fail_count INTEGER NOT NULL DEFAULT 0, -- runs that crashed; the sweep stops at 3
        announce_outcome TEXT         -- AnnouncementPlayer.Outcome, lowercased
   ```
7. `src/pipeline/types.ts`: in `MeetingStatus`, replace `  | 'error';` with:
   ```ts
     // No speech: the recording was heard and held nothing to transcribe. Never a crash.
     | 'error'
     // Processing crashed. The reason is on the meeting (failReason); the sweep retries it.
     | 'failed';
   ```
   and in `interface Meeting`, after the `mode?: 'dictation' | null;` line:
   ```ts
     /** 'stopped' for every Stop, else why the recording service ended it. Null before Phase B. */
     endReason?: string | null;
     /** Set with status 'failed': what went wrong, in words a person can act on. */
     failReason?: string | null;
     /** AnnouncementPlayer's outcome, lowercased: played | disabled | silenced | not_heard | no_clip | failed. */
     announceOutcome?: string | null;
   ```
8. `src/db/queries.ts`:
   - Above `export type MeetingSort` (line 26) add:
     ```ts
     /** Unfinished meetings for the sweep, and crashed ones until they have failed three times. */
     export const PENDING_MEETINGS_SQL =
       "SELECT id FROM meetings WHERE status IN ('captured','vad','asr','diarized') " +
       "OR (status = 'failed' AND fail_count < 3) ORDER BY created_at";

     /** Recordings that yielded no transcript. 'error' only: a crash is not an empty recording. */
     export const EMPTY_MEETINGS_SQL =
       "SELECT id FROM meetings WHERE status = 'error' AND archived_at IS NULL " +
       'AND id NOT IN (SELECT DISTINCT meeting_id FROM utterances)';
     ```
   - `emptyMeetings` (line 137): body becomes `run<{ id: string }>(EMPTY_MEETINGS_SQL),`.
   - `pendingMeetings` (line 438): body becomes `run<{ id: string }>(PENDING_MEETINGS_SQL),`.
   - `listMeetings` (line 109): `'diar_skipped_reason AS diarSkippedReason, mode ' +` becomes
     `'diar_skipped_reason AS diarSkippedReason, mode, fail_reason AS failReason ' +`.
   - `getMeeting` (line 164): `'… template_source AS templateSource, mode ' +` becomes
     `'diar_skipped_reason AS diarSkippedReason, template, template_source AS templateSource, mode, ' +`
     followed by a new line
     `'end_reason AS endReason, fail_reason AS failReason, announce_outcome AS announceOutcome ' +`.
9. Run both commands from 4 → pass. `npx tsc --noEmit 2>&1 | tail -5` → nothing.

**Mutant M1:** in `PENDING_MEETINGS_SQL` change `fail_count < 3` to `fail_count < 99` → *a meeting
that failed three times…* fails. Restore.

Commit: `feat(db): a failed status, how a recording ended, and the announcement's outcome`.

#### Step 2. A crash is `failed`, with a reason, and runs again from where it stopped

**Tests first.**

1. `T/pipeline/ResumePlanTest.kt`, add inside the class:
   ```kotlin
   /** A crash before VAD saved anything must start from VAD, not be read as "no speech". */
   @Test fun aCrashBeforeVadIsRunAgainFromTheStart() =
     assertEquals(
       listOf(Stage.VAD, Stage.ASR, Stage.DIARIZE, Stage.NARRATE),
       plan("failed", seg = false, utt = false, spk = false),
     )

   @Test fun aCrashAfterTheTranscriptResumesWhereItStopped() =
     assertEquals(listOf(Stage.DIARIZE, Stage.NARRATE), plan("failed", seg = true, utt = true, spk = false))
   ```
2. New file `T/pipeline/FailureReasonTest.kt`:
   ```kotlin
   package com.innocorelabs.verbale.pipeline

   import org.junit.Assert.assertEquals
   import org.junit.Assert.assertTrue
   import org.junit.Test

   class FailureReasonTest {
     @Test fun outOfMemoryIsSaidAsMemory() =
       assertTrue(FailureReason.of(OutOfMemoryError()).contains("ran out of memory"))

     @Test fun aMissingLibraryIsTheSpeechEngine() =
       assertTrue(FailureReason.of(UnsatisfiedLinkError("dlopen failed")).contains("speech engine"))

     @Test fun theProcessorCheckKeepsItsOwnSentence() =
       assertEquals(DeviceFit.CPU_REASON, FailureReason.of(IllegalStateException(DeviceFit.CPU_REASON)))

     @Test fun missingAudioSaysSo() =
       assertTrue(FailureReason.of(IllegalStateException("no audio for m1")).contains("audio file is missing"))

     @Test fun aMissingSpeechDetectorSaysSo() =
       assertTrue(
         FailureReason.of(IllegalStateException("silero_vad.onnx not found — place it in assets/"))
           .contains("speech detector"),
       )

     /** Exception text is for the log. A person never reads "SQLiteException: no such column". */
     @Test fun anythingElseIsThePlainFallbackNeverTheRawMessage() =
       assertEquals(FailureReason.FALLBACK, FailureReason.of(RuntimeException("SQLiteException: no such column x")))
   }
   ```
3. `cd android && ./gradlew :app:testDebugUnitTest --tests '*ResumePlanTest*' --tests '*FailureReasonTest*' 2>&1 | grep -E "BUILD|FAILED|error:" | tail -5` → FAILED.

**Code.**

4. New file `K/pipeline/FailureReason.kt`:
   ```kotlin
   package com.innocorelabs.verbale.pipeline

   /**
    * What a crashed processing run tells the person, in words they can act on. The exception itself
    * goes to the log; its message is never shown, because it is written for a developer.
    */
   object FailureReason {
     const val FALLBACK = "Processing stopped unexpectedly. The recording is safe — tap Try again."

     fun of(e: Throwable): String {
       val message = e.message ?: ""
       return when {
         e is OutOfMemoryError ->
           "The phone ran out of memory while processing. Close other apps, then tap Try again."
         e is UnsatisfiedLinkError ->
           "The speech engine could not start on this phone. Reinstalling Verbale usually fixes this."
         message == DeviceFit.CPU_REASON -> DeviceFit.CPU_REASON
         message.startsWith("no audio for") ->
           "The recording's audio file is missing, so there is nothing to process."
         message.startsWith("silero_vad.onnx not found") ->
           "The speech detector is not on the phone yet. Connect to the internet, open Verbale, then tap Try again."
         else -> FALLBACK
       }
     }
   }
   ```
5. `K/pipeline/ResumePlan.kt` line 44: replace
   `    if (!s.hasSegments && s.status != "captured") return emptyList()` with
   ```kotlin
       // 'failed' is a crash, not a verdict: with no segments it starts again from VAD.
       if (!s.hasSegments && s.status != "captured" && s.status != "failed") return emptyList()
   ```
6. `K/data/AudioDb.kt`, after `fun setStatus(...)` (line 687–689) add:
   ```kotlin
     /** A processing run crashed: its own status (not 'error', which is "no speech"), the reason, one more strike. */
     fun markFailed(id: String, reason: String) {
       db.execSQL(
         "UPDATE meetings SET status='failed', fail_reason=?, fail_count=fail_count+1 WHERE id=?",
         arrayOf<Any?>(reason, id),
       )
     }
   ```
7. `K/pipeline/ProcessingEngine.kt` lines 470–471: replace
   ```kotlin
         try { AudioDb.get(ctx).setStatus(meetingId, "error") } catch (_: Exception) {}
         listener.onComplete("error", e.message ?: e.toString())
   ```
   with
   ```kotlin
         val reason = FailureReason.of(e)
         try { AudioDb.get(ctx).markFailed(meetingId, reason) } catch (_: Exception) {}
         listener.onComplete("error", reason)
   ```
8. Run the command from 3 → `BUILD SUCCESSFUL`.

**Mutant M2:** in `ResumePlan.kt` delete ` && s.status != "failed"` → *aCrashBeforeVadIsRunAgainFromTheStart*
fails. Restore. **Mutant M3:** in `FailureReason.of` delete the `e is OutOfMemoryError ->` branch (both
lines) → *outOfMemoryIsSaidAsMemory* fails. Restore.

Commit: `fix(pipeline): a crash is 'failed' with a reason a person can act on, and runs again`.

#### Step 3. Every ending is stored, processed and explained

**Tests first.** New file `T/pipeline/EndNoticeTest.kt`:
```kotlin
package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EndNoticeTest {
  private val someAudio = 32_000L // one second

  @Test fun aStopIsStoredAsStoppedAndExplainsNothing() {
    assertEquals("stopped", EndNotice.stored(RecordingService.END_NORMAL))
    assertFalse(EndNotice.shouldProcess(RecordingService.END_NORMAL, someAudio))
    assertNull(EndNotice.of(RecordingService.END_NORMAL, someAudio, processing = true, capMinutes = 15))
  }

  @Test fun everyOtherEndingWithAudioIsProcessedAndStoredByName() {
    for (r in listOf(
      RecordingService.END_CAP_REACHED, RecordingService.END_MIC_LOST,
      RecordingService.END_DISK_FULL, RecordingService.END_WRITE_FAILED,
    )) {
      assertTrue(r, EndNotice.shouldProcess(r, someAudio))
      assertEquals(r, EndNotice.stored(r))
    }
  }

  @Test fun nothingCapturedIsNothingToProcess() {
    assertFalse(EndNotice.shouldProcess(RecordingService.END_MIC_UNAVAILABLE, 0L))
    assertFalse(EndNotice.shouldProcess(RecordingService.END_DISK_FULL, 0L))
    val n = EndNotice.of(RecordingService.END_MIC_UNAVAILABLE, 0L, processing = false, capMinutes = 0)!!
    assertEquals("Could not start recording", n.title)
    assertTrue(n.body.contains("Nothing was recorded"))
  }

  /** The old free-limit notice promised transcription that nothing had queued. */
  @Test fun theNoticeSaysWhetherItIsBeingTranscribed() {
    val queued = EndNotice.of(RecordingService.END_MIC_LOST, someAudio, processing = true, capMinutes = 0)!!
    val refused = EndNotice.of(RecordingService.END_MIC_LOST, someAudio, processing = false, capMinutes = 0)!!
    assertTrue(queued.body.contains("It is being transcribed now."))
    assertTrue(refused.body.contains("Open Verbale to transcribe it."))
    assertFalse(refused.body.contains("being transcribed"))
  }

  @Test fun theFreeLimitNoticeNamesTheLimit() =
    assertEquals(
      "Stopped at the 15-minute Free limit",
      EndNotice.of(RecordingService.END_CAP_REACHED, someAudio, processing = true, capMinutes = 15)!!.title,
    )
}
```
Run `cd android && ./gradlew :app:testDebugUnitTest --tests '*EndNoticeTest*' 2>&1 | grep -E "BUILD|FAILED|error:" | tail -5` → FAILED.

**Code.**

1. `K/pipeline/RecordingService.kt`, after `const val END_CAP_REACHED = "cap_reached"` (line 106):
   ```kotlin

       /** Anything else thrown in the capture loop — a write that failed. The audio so far is kept. */
       const val END_WRITE_FAILED = "write_failed"

       /** The recorder could not be opened at all; nothing was captured. */
       const val END_MIC_UNAVAILABLE = "mic_unavailable"
   ```
   and change the KDoc at line 94 to
   `/** Why capture ended. Stored on the meeting as end_reason (EndNotice.stored). */`.
2. New file `K/pipeline/EndNotice.kt`:
   ```kotlin
   package com.innocorelabs.verbale.pipeline

   /**
    * How a recording ended, decided in one place: what the meeting stores, whether the service sends
    * it for processing itself, and what the notification says. Pure, so EndNoticeTest can hold every
    * reason. A Stop — screen, notification, PiP or tile — is queued by whoever pressed it.
    */
   object EndNotice {
     data class Notice(val title: String, val body: String)

     /** The meeting row's end_reason. */
     fun stored(reason: String): String =
       if (reason == RecordingService.END_NORMAL) "stopped" else reason

     fun shouldProcess(reason: String, capturedBytes: Long): Boolean =
       reason != RecordingService.END_NORMAL && capturedBytes > 0L

     /** Null for a Stop. [processing] is whether the queueing went through. */
     fun of(reason: String, capturedBytes: Long, processing: Boolean, capMinutes: Int): Notice? {
       if (reason == RecordingService.END_NORMAL) return null
       if (capturedBytes <= 0L) {
         return if (reason == RecordingService.END_DISK_FULL) {
           Notice("Could not start recording", "The phone is out of space. Free some up and try again. Nothing was recorded.")
         } else {
           Notice("Could not start recording", "The microphone could not be opened — another app may be using it. Nothing was recorded.")
         }
       }
       val next = if (processing) "It is being transcribed now." else "Open Verbale to transcribe it."
       return when (reason) {
         RecordingService.END_CAP_REACHED ->
           Notice("Stopped at the $capMinutes-minute Free limit", "The recording is kept. $next Pro records without a limit.")
         RecordingService.END_MIC_LOST ->
           Notice("Recording stopped: the microphone was taken", "A call or another app took the microphone. What was recorded is kept. $next")
         RecordingService.END_DISK_FULL ->
           Notice("Recording stopped: the phone is out of space", "What was recorded is kept. $next")
         else ->
           Notice("Recording stopped: the audio could not be saved", "What was recorded is kept. $next")
       }
     }
   }
   ```
3. `RecordingService.kt` `startCapture`:
   - line 302 (`Log.e(TAG, "AudioRecord init failed", e)`): add `      endReason = END_MIC_UNAVAILABLE` on
     the next line, before `stopSelf()`.
   - line 307 (`Log.e(TAG, "AudioRecord not initialized (permission?)")`): add
     `      endReason = END_MIC_UNAVAILABLE` on the next line.
4. `RecordingService.kt` capture loop catch (line 471–472): replace
   ```kotlin
           } catch (e: Exception) {
             Log.e(TAG, "capture loop error", e)
   ```
   with
   ```kotlin
           } catch (e: Exception) {
             Log.e(TAG, "capture loop error", e)
             // End it: before this the loop died and the service stayed up, showing "Recording"
             // over a recorder that was no longer writing anything.
             if (endReason == END_NORMAL) endReason = END_WRITE_FAILED
             recording = false
   ```
5. `RecordingService.kt`: rename `CAP_NOTICE_ID` to `END_NOTICE_ID` (line 62, KDoc becomes
   `/** How a recording ended, when the service ended it — separate from NOTIF_ID, which goes when the service does. 43/44 are ProcessingService's. */`),
   and replace the whole `private fun postCapReachedNotice() { … }` (lines 711–738, KDoc included)
   with:
   ```kotlin
     /**
      * How the recording ended, when the service ended it — very likely with the screen off or in
      * PiP, where nothing else said so. Plain and silent; tapping opens the app, whose Library sweep
      * processes anything the service could not queue.
      */
     private fun postEndNotice(notice: EndNotice.Notice) {
       val open = PendingIntent.getActivity(
         this, 5,
         Intent(this, com.innocorelabs.verbale.MainActivity::class.java)
           .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK),
         PendingIntent.FLAG_IMMUTABLE,
       )
       val n = NotificationCompat.Builder(this, CHANNEL_ID)
         .setContentTitle(notice.title)
         .setContentText(notice.body)
         .setStyle(NotificationCompat.BigTextStyle().bigText(notice.body))
         .setSmallIcon(R.drawable.ic_notification_rec)
         .setSilent(true)
         .setAutoCancel(true)
         .setContentIntent(open)
         .build()
       try {
         NotificationManagerCompat.from(this).notify(END_NOTICE_ID, n)
       } catch (_: Exception) {
         // POST_NOTIFICATIONS denied. The meeting says the same thing when it is opened.
       }
     }
   ```
6. `RecordingService.kt` `onDestroy`, lines 612–627: replace from `    val id = meetingId` through
   `    if (endReason == END_CAP_REACHED) postCapReachedNotice()` with:
   ```kotlin
       val id = meetingId
       val path = audioPath
       if (id != null && path != null) {
         val bytes = File(path).length()
         val durationMs = bytes / BYTES_PER_MS
         try {
           val db = AudioDb.get(applicationContext)
           db.markCaptured(id, durationMs, path)
           db.setEndReason(id, EndNotice.stored(endReason))
           // Nothing captured is nothing to process: 'captured' would send an empty file down the pipeline.
           if (bytes == 0L) db.setStatus(id, "error")
         } catch (e: Exception) {
           Log.e(TAG, "markCaptured failed", e)
         }
         Log.i(TAG, "capture finished for $id: ${bytes}B (${durationMs}ms), reason=$endReason")
         // A Stop is queued by whoever pressed it. Every other ending is queued here, and Android may
         // refuse a background start — the notice then says to open the app, whose sweep does it.
         val processing = EndNotice.shouldProcess(endReason, bytes) && try {
           ProcessingService.enqueue(applicationContext, id)
           true
         } catch (e: Exception) {
           Log.w(TAG, "could not queue $id after $endReason — the Library sweep will", e)
           false
         }
         // Read before onCaptureEnded clears the limit.
         val capMinutes = (CaptureController.capMs / 60_000L).toInt()
         EndNotice.of(endReason, bytes, processing, capMinutes)?.let { postEndNotice(it) }
       }
   ```
7. `RecordingService.kt` the `CaptureController.onCaptureEnded(when (endReason) { … })` mapping
   (lines 636–642) becomes:
   ```kotlin
       CaptureController.onCaptureEnded(
         when (endReason) {
           END_MIC_LOST, END_MIC_UNAVAILABLE -> CaptureController.END_MIC_LOST
           END_DISK_FULL, END_WRITE_FAILED -> CaptureController.END_WRITE_FAILED
           else -> CaptureController.END_STOPPED
         },
       )
   ```
8. `K/data/AudioDb.kt`, after `fun markCaptured(...)` (lines 525–530) add:
   ```kotlin
     /** How the recording ended — see EndNotice.stored. */
     fun setEndReason(id: String, reason: String) {
       db.execSQL("UPDATE meetings SET end_reason=? WHERE id=?", arrayOf<Any?>(reason, id))
     }
   ```
9. `K/pipeline/RecordTileService.kt` line 80: replace
   `      Thread { CaptureController.stop(app) }.start()` with
   ```kotlin
         // A Stop like the notification's, so it is queued the same way: tapping a tile lets the
         // app start the processing service from the background.
         Thread {
           val stopped = CaptureController.stop(app)
           if (stopped != null) {
             try { ProcessingService.enqueue(app, stopped) }
             catch (e: Exception) { android.util.Log.w("RecordTileService", "could not queue $stopped", e) }
           }
         }.start()
   ```
   (`CaptureController.stop` returns `String?` — the meeting id — as the notification path at
   `RecordingService.kt:206` uses it.)
10. `strings.xml`: delete `notif_cap_reached_title` and `notif_cap_reached_body` (lines 21–22) —
    `git grep -n "notif_cap_reached" -- android` must then print nothing.
11. `cd android && ./gradlew :app:testDebugUnitTest --tests '*EndNoticeTest*' 2>&1 | grep -E "BUILD|FAILED|error:" | tail -5`
    → `BUILD SUCCESSFUL`; then `./gradlew :app:compileDebugKotlin 2>&1 | grep -E "BUILD|error:" | tail -5` → `BUILD SUCCESSFUL`.

**Mutant M4:** in `EndNotice.shouldProcess` change `capturedBytes > 0L` to `capturedBytes >= 0L` →
*nothingCapturedIsNothingToProcess* fails. Restore.

Commit: `fix(record): every ending is stored, queued and explained — the free limit, a lost mic, a full disk, the tile`.

#### Step 4. The announcement's outcome: stored, and warned about for two minutes

**Tests first.** `T/pipeline/CaptureWarningsTest.kt`, add inside the class:
```kotlin
  @Test fun `an unheard announcement outranks loud and faint but not storage`() {
    assertEquals(
      CaptureWarnings.Kind.UNANNOUNCED,
      CaptureWarnings.pick(30L, loud = true, faint = true, storageWarnAtMinutes = 5L, unannounced = true)?.kind,
    )
    assertEquals(
      CaptureWarnings.Kind.STORAGE,
      CaptureWarnings.pick(4L, loud = false, faint = false, storageWarnAtMinutes = 5L, unannounced = true)?.kind,
    )
  }

  @Test fun `the unheard warning shows for two minutes of capture, then gives way`() {
    assertFalse(CaptureWarnings.unannouncedShowing(notHeardAtMs = -1L, nowMs = 0L))
    assertTrue(CaptureWarnings.unannouncedShowing(notHeardAtMs = 10_000L, nowMs = 10_000L))
    assertTrue(CaptureWarnings.unannouncedShowing(notHeardAtMs = 10_000L, nowMs = 129_999L))
    assertFalse(CaptureWarnings.unannouncedShowing(notHeardAtMs = 10_000L, nowMs = 130_000L))
  }
```
Add `import org.junit.Assert.assertFalse` and `import org.junit.Assert.assertTrue` to the imports if
not present. Run `cd android && ./gradlew :app:testDebugUnitTest --tests '*CaptureWarningsTest*' 2>&1 | grep -E "BUILD|FAILED|error:" | tail -5` → FAILED.

**Code.**

1. `K/pipeline/CaptureWarnings.kt`:
   - `enum class Kind { STORAGE, LOUD, FAINT }` becomes `enum class Kind { STORAGE, UNANNOUNCED, LOUD, FAINT }`.
   - Replace `fun pick(...)` with:
     ```kotlin
       fun pick(
         storageMinutesLeft: Long,
         loud: Boolean,
         faint: Boolean,
         storageWarnAtMinutes: Long,
         unannounced: Boolean = false,
       ): Warning? = when {
         storageMinutesLeft < storageWarnAtMinutes -> Warning(Kind.STORAGE, storageMinutesLeft)
         unannounced -> Warning(Kind.UNANNOUNCED, storageMinutesLeft)
         loud -> Warning(Kind.LOUD, storageMinutesLeft)
         faint -> Warning(Kind.FAINT, storageMinutesLeft)
         else -> null
       }

       /**
        * How long "the announcement was not heard" holds the warning slot, in ms of capture. Long
        * enough to be seen and acted on; after it, loud and faint get their turn again. The meeting
        * keeps the permanent record (announce_outcome).
        */
       const val UNANNOUNCED_SHOW_MS = 120_000L

       /** [notHeardAtMs] is -1 when the announcement was heard, is switched off, or is not decided yet. */
       fun unannouncedShowing(notHeardAtMs: Long, nowMs: Long): Boolean =
         notHeardAtMs >= 0L && nowMs - notHeardAtMs < UNANNOUNCED_SHOW_MS
     ```
2. `K/pipeline/CaptureController.kt`:
   - after `@Volatile var warning: CaptureWarnings.Warning? = null` (line 111) add:
     ```kotlin
       /** Capture-clock ms when the announcement was found not heard; -1 otherwise. */
       @Volatile var unannouncedAtMs: Long = -1L

       /** From the announce thread, once the verdict is in. Switched off is a choice, not a warning. */
       fun noteAnnouncement(outcome: AnnouncementPlayer.Outcome) {
         if (!outcome.wasHeard() && outcome != AnnouncementPlayer.Outcome.DISABLED) unannouncedAtMs = capturedMs
       }
     ```
   - in `refreshWarning`, the `CaptureWarnings.pick(` call gains a last argument after
     `storageWarnAtMinutes = STORAGE_WARN_MINUTES,`:
     `      unannounced = CaptureWarnings.unannouncedShowing(unannouncedAtMs, capturedMs),`
   - in `clearWarnings()` add `    unannouncedAtMs = -1L` after `    warning = null`.
3. `K/data/AudioDb.kt`, after `fun markAnnounced(...)` (lines 570–575) add:
   ```kotlin
     /** Every new recording's announcement outcome, heard or not — the meeting's "announced" line. */
     fun setAnnounceOutcome(id: String, outcome: String) {
       db.execSQL("UPDATE meetings SET announce_outcome=? WHERE id=?", arrayOf<Any?>(outcome, id))
     }
   ```
4. `K/pipeline/RecordingService.kt` announce thread, immediately before
   `            if (outcome.wasHeard()) {` (line 382) insert:
   ```kotlin
               meetingId?.let { db.setAnnounceOutcome(it, outcome.name.lowercase()) }
               CaptureController.noteAnnouncement(outcome)
   ```
5. `RecordingService.kt` `buildNotification`, after
   `        CaptureWarnings.Kind.FAINT -> getString(R.string.notif_warn_faint)` (line 836) add
   `        CaptureWarnings.Kind.UNANNOUNCED -> getString(R.string.notif_warn_unannounced)`.
6. `strings.xml`, after the `notif_warn_storage` line add:
   `    <string name="notif_warn_unannounced">The announcement was not heard — tell the room you are recording.</string>`
7. `src/native/NativeAudioPipeline.ts` line 78 comment: `'loud'|'faint'|'storage'|null` becomes
   `'storage'|'unannounced'|'loud'|'faint'|null`.
8. Run the command above → `BUILD SUCCESSFUL`; `./gradlew :app:compileDebugKotlin 2>&1 | grep -E "BUILD|error:" | tail -5` → `BUILD SUCCESSFUL`.

**Mutant M5:** in `unannouncedShowing` change `<` to `<=` → *the unheard warning shows for two
minutes…* fails. Restore.

Commit: `feat(record): an announcement nobody heard is stored on the meeting and warned about`.

#### Step 4b. (B7, added 25 Sep) A clip that was FOUND is kept out of ASR, heard or not

*Found on the A07 (defect 3 of `reports/2026-09-25-a07-play-build-feature-pass.md`): verdict
`heard=false found=true peak/bg=9.79 loudness=1.20`. `announced_lag_ms` is written only inside
`markAnnounced`, which runs only for a HEARD clip, so nothing kept the clip out of whisper. The
transcript opened "recorded by Verbali. The recording stays on this phone." and the meeting was
titled "Recorded by Verbali". **Rule: exclusion keys on `found`; the `announced_at` stamp keys on
`heard`.** The stamp and `markAnnounced` do not change.*

Files (add to your reading, beyond §1): `K/pipeline/AnnouncementSpan.kt` 20–35,
`T/pipeline/AnnouncementSpanTest.kt` 1–30, `K/pipeline/AnnouncementVerifier.kt` 150–161 (read
only: the `Verdict` class; the file stays on the must-not-change list),
`K/pipeline/RecordingService.kt` 370–380 (`grep -n "verdict.found" K/pipeline/RecordingService.kt`).

**Tests first.** Append to `T/pipeline/AnnouncementSpanTest.kt`, inside the class:

```kotlin
  private fun verdict(heard: Boolean, found: Boolean, lagFrames: Int) =
    AnnouncementVerifier.Verdict(heard, found, peakOverBackground = 9.79f, loudnessRatio = 1.2f, lagFrames = lagFrames)

  @Test
  fun `a clip found but too quiet to count as heard is still kept out of ASR`() {
    // The A07, 25 Sep: heard=false found=true. Whisper transcribed the clip and titled the meeting with it.
    assertEquals(350L, AnnouncementSpan.lagToExclude(verdict(heard = false, found = true, lagFrames = 35)))
  }

  @Test
  fun `a heard clip is kept out too`() {
    assertEquals(350L, AnnouncementSpan.lagToExclude(verdict(heard = true, found = true, lagFrames = 35)))
  }

  @Test
  fun `a clip that was not found leaves the speech alone`() {
    // Not found means nothing matched: cutting the opening seconds there would cut real speech.
    assertNull(AnnouncementSpan.lagToExclude(verdict(heard = false, found = false, lagFrames = 35)))
  }
```

Add `import org.junit.Assert.assertEquals` and `import org.junit.Assert.assertNull` beside the
existing `assertArrayEquals` import. Run
`cd android && ./gradlew :app:testDebugUnitTest --tests '*AnnouncementSpanTest*' 2>&1 | grep -E "BUILD|FAILED|error:" | tail -5`
→ compile failure (`lagToExclude` does not exist). That is the failing test.

**Code.**

1. `K/pipeline/AnnouncementSpan.kt`, directly after `const val MARGIN_MS = 500L` add:
   ```kotlin

     /**
      * Where the clip starts in the capture, in ms, for keeping ASR off it — or null to keep
      * nothing out. Keyed on FOUND, not heard: "heard" asks whether the clip is loud enough to be
      * evidence the room was told, and a clip too quiet for that is still loud enough for whisper
      * to transcribe (the A07, 25 Sep: found, not heard, and the meeting was titled with it).
      */
     fun lagToExclude(verdict: AnnouncementVerifier.Verdict): Long? =
       if (verdict.found) verdict.lagFrames * 10L else null
   ```
2. `K/data/AudioDb.kt`, directly after `fun markAnnounced(...)` (and before the
   `setAnnounceOutcome` you added in Step 4) add:
   ```kotlin
     /**
      * Where the clip sits, written whenever the verifier FOUND it, heard or not, so ASR can keep
      * off it. [markAnnounced] writes the same lag again for a heard clip; `announced_at` stays
      * the heard-only stamp.
      */
     fun setAnnouncedLag(id: String, lagMs: Long) {
       db.execSQL("UPDATE meetings SET announced_lag_ms=? WHERE id=?", arrayOf<Any?>(lagMs, id))
     }
   ```
   Also correct the `markAnnounced` doc comment's second sentence: `Only ever called for
   Outcome.PLAYED.` becomes `Only ever called for Outcome.PLAYED; a clip found but not heard gets
   its lag from [setAnnouncedLag] instead.`
3. `K/pipeline/RecordingService.kt`, replace the line
   `                if (verdict.found) announcedLagMs = verdict.lagFrames * 10L`
   with:
   ```kotlin
                   announcedLagMs = AnnouncementSpan.lagToExclude(verdict)
                   // Written now, heard or not: the stamp below is heard-only, the exclusion is not.
                   val lag = announcedLagMs
                   if (lag != null) meetingId?.let { db.setAnnouncedLag(it, lag) }
   ```
   Nothing else in the announce thread changes; the `markAnnounced` call stays exactly as it is.
4. Re-run the test command → `BUILD SUCCESSFUL`; then
   `cd android && ./gradlew :app:compileDebugKotlin 2>&1 | grep -E "BUILD|error:" | tail -5` → `BUILD SUCCESSFUL`.

**Mutant M12:** in `lagToExclude` change `verdict.found` to `verdict.heard` → *a clip found but
too quiet to count as heard is still kept out of ASR* fails. Restore.

**Not unit-testable, proved on the phone instead:** that the lag reaches the row for a quiet clip.
The re-run of the A07 pass (fix plan item 6) checks it: media volume 2, record, and the transcript
must not open with "recorded by Verbali". Say so in the progress file under *Notes for the next
session*.

Commit: `fix(record): a consent clip found but not heard is kept out of the transcript`.

#### Step 5. Session B1 gate

1. `GATE_STAGES="types js scans mutations kotlin cpp" scripts/gate.sh 2>&1 | grep -E "==>|ok |FAILED|gate:" | tail -20`
   → every stage `ok`. Force Kotlin:
   `cd android && ./gradlew :app:testDebugUnitTest --rerun-tasks 2>&1 | grep -E "BUILD|FAILED" | tail -3`.
2. Update the progress file (Steps 1–5 and 4b ticked, mutants M1–M5 and M12), commit
   `docs(progress): Phase B session B1 done`. Stop. Session B2 starts from here.

### Session B2 — screens, gate, report

#### Step 6. Three pure pieces of copy: endings, the announcement line, what an empty meeting is

**Tests first.** New file `src/screens/meeting/__tests__/meetingNotes.test.ts`:
```ts
import { announceLine, endingNote, holdFor } from '../meetingNotes';

describe('endingNote', () => {
  it('says nothing for a Stop, or for a meeting from before endings were kept', () => {
    expect(endingNote('stopped', 60_000)).toBeNull();
    expect(endingNote(null, 60_000)).toBeNull();
    expect(endingNote(undefined, 60_000)).toBeNull();
  });
  it('names the reason and says what was kept', () => {
    expect(endingNote('mic_lost', 60_000)).toBe(
      'Stopped early: a call or another app took the microphone. Everything up to that point is kept.',
    );
    expect(endingNote('cap_reached', 60_000)).toBe('Stopped at the Free limit. Everything up to that point is kept.');
  });
  it('says nothing was recorded when nothing was', () => {
    expect(endingNote('mic_unavailable', 0)).toBe('The microphone could not be opened, so nothing was recorded.');
  });
});

describe('announceLine', () => {
  it('announced is said plainly, not as a warning', () => {
    expect(announceLine('played')).toEqual({ text: 'Announced at the start of the recording.', warn: false });
  });
  it('every other outcome is "not announced", with why', () => {
    expect(announceLine('silenced')).toEqual({ text: 'Not announced: the phone was on silent.', warn: true });
    expect(announceLine('not_heard')?.text).toBe('Not announced: the recording did not pick the announcement up.');
    expect(announceLine('disabled')?.text).toBe('Not announced: the announcement is switched off.');
    expect(announceLine('failed')?.text).toBe('Not announced: the announcement did not play.');
    expect(announceLine('no_clip')?.text).toBe('Not announced: the announcement did not play.');
  });
  it('a meeting from before outcomes were kept says nothing', () => {
    expect(announceLine(null)).toBeNull();
    expect(announceLine('something new')).toBeNull();
  });
});

describe('holdFor — what a meeting with nothing written is', () => {
  const m = (status: string, durationMs = 60_000) => ({ status, durationMs });
  it('queued, part-way, or waiting for its speech model is waiting — never silent', () => {
    for (const s of ['recording', 'captured', 'vad', 'asr', 'diarized']) expect(holdFor(m(s))).toBe('waiting');
    expect(holdFor(null)).toBe('waiting');
  });
  it('a crash is failed', () => expect(holdFor(m('failed'))).toBe('failed'));
  it('no speech needs audio; no audio is its own thing', () => {
    expect(holdFor(m('error'))).toBe('no-speech');
    expect(holdFor(m('error', 0))).toBe('no-audio');
  });
});
```
Run `npx jest src/screens/meeting/__tests__/meetingNotes.test.ts --silent 2>&1 | grep -E "Tests:|✕" | tail -5` → fails.

**Code.** New file `src/screens/meeting/meetingNotes.ts`:
```ts
/**
 * The sentences a meeting says about itself that are not its content: how the recording ended,
 * whether the room was told, and — when nothing is written yet — which of four very different
 * situations this is. Pure, so they are tested without rendering a screen.
 */

const ENDED: Record<string, string> = {
  cap_reached: 'Stopped at the Free limit',
  mic_lost: 'Stopped early: a call or another app took the microphone',
  disk_full: 'Stopped early: the phone ran out of space',
  write_failed: 'Stopped early: the audio could not be saved',
  mic_unavailable: 'The microphone could not be opened',
};

/** Null for a Stop, and for meetings recorded before the reason was kept. */
export function endingNote(reason: string | null | undefined, durationMs: number): string | null {
  const why = reason ? ENDED[reason] : undefined;
  if (!why) return null;
  return durationMs > 0 ? `${why}. Everything up to that point is kept.` : `${why}, so nothing was recorded.`;
}

/** AnnouncementPlayer's outcome as one line. Null when the meeting predates the outcome being kept. */
export function announceLine(outcome: string | null | undefined): { text: string; warn: boolean } | null {
  switch (outcome) {
    case 'played':
      return { text: 'Announced at the start of the recording.', warn: false };
    case 'silenced':
      return { text: 'Not announced: the phone was on silent.', warn: true };
    case 'not_heard':
      return { text: 'Not announced: the recording did not pick the announcement up.', warn: true };
    case 'disabled':
      return { text: 'Not announced: the announcement is switched off.', warn: true };
    case 'failed':
    case 'no_clip':
      return { text: 'Not announced: the announcement did not play.', warn: true };
    default:
      return null;
  }
}

export type Hold = 'waiting' | 'failed' | 'no-speech' | 'no-audio';

const PENDING = ['recording', 'captured', 'vad', 'asr', 'diarized'];

/**
 * What a meeting with nothing written is. Only 'no-speech' may say "could not hear any speech":
 * a queued meeting, one waiting for its model, and a crash all used to.
 */
export function holdFor(m: { status: string; durationMs: number } | null | undefined): Hold {
  if (!m || PENDING.includes(m.status)) return 'waiting';
  if (m.status === 'failed') return 'failed';
  return m.durationMs > 0 ? 'no-speech' : 'no-audio';
}
```
Run the test → passes.

**Mutant M6:** delete `'vad', ` from `PENDING` → *queued, part-way, or waiting…* fails. Restore.

Commit: `feat(meeting): endings, the announcement line and the empty states as plain functions`.

#### Step 7. The Meeting screen: never "no speech" unless it is; failed says why; Write it again keeps the summary

**Tests first.** `src/screens/__tests__/MeetingScreen.test.tsx`:

1. Add `import SummaryTab from '../meeting/SummaryTab';` below the existing imports, and in
   `beforeEach` add `(db.clearNarration as jest.Mock).mockResolvedValue(undefined);`.
2. Append:
   ```tsx
   const pipeline = () => (global as any).__TEST_NATIVE_MODULES__.AudioPipeline;
   const meetingWith = (over: Record<string, unknown>) => ({
     id: 'm1', title: 'Standup', createdAt: 1, durationMs: 60_000, status: 'done',
     tierUsed: 'free', language: 'en', audioPath: null, audioRetained: 1, ...over,
   });
   const pressLabel = async (tree: renderer.ReactTestRenderer, label: string) => {
     const n = tree.root.findAll(x => x.props.label === label && typeof x.props.onPress === 'function')[0];
     await act(async () => {
       n.props.onPress();
     });
   };

   describe('what a meeting with nothing written says', () => {
     it('a crash says why and offers Try again — never "could not hear any speech"', async () => {
       (db.getMeeting as jest.Mock).mockResolvedValue(
         meetingWith({ status: 'failed', failReason: 'The phone ran out of memory while processing.' }),
       );
       (db.minutes as jest.Mock).mockResolvedValue([]);
       const tree = await render();
       const text = JSON.stringify(tree.toJSON());
       expect(text).toContain("Didn't finish");
       expect(text).toContain('ran out of memory');
       expect(text).not.toContain('could not hear any speech');
       await pressLabel(tree, 'Try again');
       expect(pipeline().process).toHaveBeenCalledWith('m1', { model: 'base' });
     });

     it('a queued meeting is "not transcribed yet", with Process now', async () => {
       (db.getMeeting as jest.Mock).mockResolvedValue(meetingWith({ status: 'captured' }));
       (db.minutes as jest.Mock).mockResolvedValue([]);
       const tree = await render();
       await act(async () => {
         emit('onStageComplete', { meetingId: 'm1', outcome: 'done' });
       });
       const text = JSON.stringify(tree.toJSON());
       expect(text).toContain('Not transcribed yet');
       expect(text).not.toContain('could not hear any speech');
       await pressLabel(tree, 'Process now');
       expect(pipeline().process).toHaveBeenCalledWith('m1', { model: 'base' });
     });

     it('no speech after a lost mic says both', async () => {
       (db.getMeeting as jest.Mock).mockResolvedValue(meetingWith({ status: 'error', endReason: 'mic_lost' }));
       (db.minutes as jest.Mock).mockResolvedValue([]);
       const tree = await render();
       const text = JSON.stringify(tree.toJSON());
       expect(text).toContain('could not hear any speech');
       expect(text).toContain('took the microphone');
     });
   });

   describe('a finished meeting says how it ended and whether it was announced', () => {
     it('shows the ending and the announcement lines', async () => {
       (db.getMeeting as jest.Mock).mockResolvedValue(
         meetingWith({ endReason: 'cap_reached', announceOutcome: 'not_heard' }),
       );
       const tree = await render();
       const text = JSON.stringify(tree.toJSON());
       expect(text).toContain('Stopped at the Free limit');
       expect(text).toContain('Not announced: the recording did not pick the announcement up.');
     });
   });

   describe('Write it again', () => {
     it('keeps the summary and asks native for a forced narration', async () => {
       const tree = await render();
       await act(async () => {
         tree.root.findByType(SummaryTab).props.onWrite();
       });
       expect(db.clearNarration).not.toHaveBeenCalled();
       expect(pipeline().process).toHaveBeenCalledWith('m1', { model: 'base', force: true });
       expect(JSON.stringify(tree.toJSON())).toContain('A short meeting about the report.');
     });
   });
   ```
3. Run `npx jest src/screens/__tests__/MeetingScreen.test.tsx --silent --forceExit 2>&1 | grep -E "Tests:|✕" | tail -10` → the five new tests fail.

**Code** in `src/screens/MeetingScreen.tsx`:

4. Import: below `import { highlightsFor, type Mark } from './meeting/highlights';` (line 15) add
   `import { announceLine, endingNote, holdFor } from './meeting/meetingNotes';`.
5. State: delete `  const [failure, setFailure] = useState<string | null>(null);` (line 102); after
   `  const [reprocessing, setReprocessing] = useState(false);` (line 94) add
   `  const [rewriting, setRewriting] = useState(false);`.
6. `onComplete` listener (line 393): delete
   `      if (e.outcome === 'error') setFailure(e.message ?? 'Processing failed');` — the reason is on
   the meeting now, and `refresh()` on the next line reads it.
7. Replace the KDoc and body of `onReprocess` (lines 404–431, grep `const onReprocess`) with:
   ```tsx
     /**
      * Run any stage that has not finished — Redo, Try again, Process now. Never rewrites prose that
      * is already written; that is onRewrite.
      */
     const onReprocess = useCallback(async () => {
       if (reprocessing) return;
       setReprocessing(true);
       try {
         await PipelineController.process(meetingId, { model: 'base' });
         await refresh();
       } catch (e: any) {
         Alert.alert('Could not reprocess', String(e?.message ?? e));
       } finally {
         setReprocessing(false);
       }
     }, [meetingId, refresh, reprocessing]);

     /**
      * "Write it again". Narration re-runs over the summary that is there, which stays on screen and
      * in the database until the new one replaces it in one transaction. A rewrite that cannot finish
      * — Pro lapsed, the model gone, the process killed — leaves it exactly as it was.
      */
     const onRewrite = useCallback(async () => {
       if (rewriting || reprocessing) return;
       setRewriting(true);
       try {
         await PipelineController.process(meetingId, { model: 'base', force: true });
         await refresh();
       } catch (e: any) {
         Alert.alert('Could not write it again', String(e?.message ?? e));
       } finally {
         setRewriting(false);
       }
     }, [meetingId, refresh, rewriting, reprocessing]);
   ```
8. Lines 842–843 (grep `const working =`): replace the two lines with:
   ```tsx
     // A rewrite keeps the summary on screen: its narrate progress must not swap the tabs for the
     // progress view. Only a meeting still waiting may sit on the progress view before it settles —
     // a crash or a silent recording is known the moment it is read.
     const hold = holdFor(meeting);
     const working =
       !refused &&
       ((stage !== null && !rewriting) ||
         (paused !== null && !rewriting) ||
         reprocessing ||
         (!settled && nothingWritten && hold === 'waiting'));
     const empty =
       !refused && !working && nothingWritten && utterances.length === 0 && (settled || hold !== 'waiting');
     const endNote = endingNote(meeting?.endReason, meeting?.durationMs ?? 0);
     const announce = announceLine(meeting?.announceOutcome);
   ```
9. Delete the `{failure ? ( … ) : null}` block (lines 1134–1141).
10. Replace the `) : empty ? (` branch's content (lines 1169–1178: the `<View style={st.emptyWrap}>`
    holding "Nothing to show") with:
    ```tsx
        <View style={st.emptyWrap}>
          <Mascot mood="asleep" size={sv(130)} />
          {hold === 'failed' ? (
            <>
              <Txt variant="display" style={st.emptyTitle}>
                Didn't finish
              </Txt>
              <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
                {meeting?.failReason ?? 'Processing stopped unexpectedly. The recording is safe.'}
              </Txt>
              <Button label="Try again" onPress={() => onReprocess()} style={st.emptyAction} />
            </>
          ) : hold === 'waiting' ? (
            <>
              <Txt variant="display" style={st.emptyTitle}>
                Not transcribed yet
              </Txt>
              <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
                It is processed on its own when the phone is free and the speech model is on the
                phone. You can also start it now.
              </Txt>
              <Button label="Process now" onPress={() => onReprocess()} style={st.emptyAction} />
            </>
          ) : hold === 'no-audio' ? (
            <>
              <Txt variant="display" style={st.emptyTitle}>
                Nothing was recorded
              </Txt>
              <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
                {endNote ?? 'The recording is empty.'}
              </Txt>
            </>
          ) : (
            <>
              <Txt variant="display" style={st.emptyTitle}>
                Nothing to show
              </Txt>
              <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
                Pip could not hear any speech in this recording. If the mic was covered or the room was
                very quiet, try again a little closer.
              </Txt>
              {endNote ? (
                <Txt variant="sub" color={colors.inkDim} style={st.emptyBody}>
                  {endNote}
                </Txt>
              ) : null}
            </>
          )}
        </View>
    ```
11. In the tabs branch, immediately before
    `          {meeting?.transcribeForcedAt ? (` (line 1184) insert:
    ```tsx
              {/* A run that crashed after writing something: the tabs show what exists, this says the rest. */}
              {meeting?.status === 'failed' ? (
                <View>
                  <View style={st.failCard}>
                    <Icon name="alert" size={s(18)} color={colors.danger} strokeWidth={2.4} />
                    <Txt variant="bodyStrong" color={colors.danger} style={st.flex}>
                      {meeting.failReason ?? 'Processing stopped unexpectedly. The recording is safe.'}
                    </Txt>
                  </View>
                  <SoftButton icon="refresh" label="Try again" onPress={() => onReprocess()} />
                </View>
              ) : null}
              {endNote ? (
                <View style={st.forcedBanner}>
                  <Txt variant="sub" color={colors.inkSoft}>
                    {endNote}
                  </Txt>
                </View>
              ) : null}
              {announce ? (
                <View style={st.forcedBanner}>
                  <Txt variant="sub" color={announce.warn ? colors.warning : colors.inkDim}>
                    {announce.text}
                  </Txt>
                </View>
              ) : null}
    ```
12. Line 1218: `onWrite={() => onReprocess(true)}` becomes `onWrite={onRewrite}`. Line 1235:
    `writing={reprocessing}` becomes `writing={reprocessing || rewriting}`.
13. `git grep -n "setFailure\|onReprocess(true)" -- src/screens/MeetingScreen.tsx` → nothing.
    `npx tsc --noEmit 2>&1 | tail -5` → nothing. Run the jest command from 3 → all pass.

**Mutant M7:** in the `empty` expression change `(settled || hold !== 'waiting')` to `settled` →
*a crash says why and offers Try again…* fails. Restore. **Mutant M8:** in `onRewrite` change
`force: true` to `force: false` → *keeps the summary and asks native for a forced narration* fails.
Restore.

Commit: `fix(meeting): "no speech" only when it is; a crash says why with Try again; Write it again keeps the summary`.

#### Step 8. Changing the meeting type asks first, and saves the type before writing

**Tests first** in `src/screens/meeting/__tests__/SummaryTab.test.tsx`, `describe('the meeting-type chip')`:

1. Replace the test *choosing a type calls onChangeTemplate with its id* with:
   ```tsx
     test('on Pro, a type change over a summary asks first, then saves the type before writing', async () => {
       (entitlement as jest.Mock).mockResolvedValue({ paid: true });
       const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
       const onChangeTemplate = jest.fn().mockResolvedValue(undefined);
       const onWrite = jest.fn();
       const tree = await renderTab({ onChangeTemplate, onWrite });
       const client = (tree.root.findByType(Sheet).props.actions as any[]).find(a => a.label === 'Client call');
       await act(async () => {
         client.onPress();
       });
       expect(alert.mock.calls[0][0]).toBe('Change to Client call?');
       expect(onChangeTemplate).not.toHaveBeenCalled();
       expect(onWrite).not.toHaveBeenCalled();
       const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
       await act(async () => {
         buttons.find(b => b.text === 'Change')!.onPress!();
       });
       expect(onChangeTemplate).toHaveBeenCalledWith('client');
       expect(onWrite).toHaveBeenCalled();
       expect(onChangeTemplate.mock.invocationCallOrder[0]).toBeLessThan(onWrite.mock.invocationCallOrder[0]);
     });

     test('Cancel changes nothing', async () => {
       (entitlement as jest.Mock).mockResolvedValue({ paid: true });
       const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
       const onChangeTemplate = jest.fn();
       const onWrite = jest.fn();
       const tree = await renderTab({ onChangeTemplate, onWrite });
       const client = (tree.root.findByType(Sheet).props.actions as any[]).find(a => a.label === 'Client call');
       await act(async () => {
         client.onPress();
       });
       const buttons = alert.mock.calls[0][2] as { text: string; style?: string }[];
       expect(buttons.find(b => b.text === 'Cancel')?.style).toBe('cancel');
       expect(onChangeTemplate).not.toHaveBeenCalled();
       expect(onWrite).not.toHaveBeenCalled();
     });
   ```
2. Delete the test *on Pro, choosing a type also triggers "Write it again"* (its behaviour is now
   the first test above).
3. In *on free, choosing a type relabels only — no rewrite*, add before `renderTab`:
   `const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});` and at the end:
   `expect(alert).not.toHaveBeenCalled();`.
4. Run `npx jest src/screens/meeting/__tests__/SummaryTab.test.tsx --silent 2>&1 | grep -E "Tests:|✕" | tail -8` → the new tests fail.

**Code** in `src/screens/meeting/SummaryTab.tsx`:

5. Line 116: `onChangeTemplate?: (id: string) => void;` becomes
   `onChangeTemplate?: (id: string) => void | Promise<void>;`.
6. Replace the `onPress` of `templateActions` (lines 296–302) with:
   ```tsx
       onPress: () => {
         // Free relabels only — the narrative itself needs Pro to be rewritten.
         if (!paid) {
           onChangeTemplate?.(id);
           return;
         }
         // Saved BEFORE the rewrite starts: the narrator reads the type from the meeting row.
         const change = async () => {
           await onChangeTemplate?.(id);
           onWrite();
         };
         if (!prose) {
           change();
           return;
         }
         Alert.alert(
           `Change to ${templateLabel(id)}?`,
           'The summary is written again in this shape. The current one stays until the new one is ready.',
           [
             { text: 'Cancel', style: 'cancel' },
             { text: 'Change', onPress: () => { change(); } },
           ],
         );
       },
   ```
7. Run the jest command from 4 → all pass; `npx tsc --noEmit 2>&1 | tail -5` → nothing.

**Mutant M9:** replace the whole `Alert.alert( … );` call with `change();` → *on Pro, a type change
over a summary asks first…* fails. Restore.

Commit: `fix(summary): changing the meeting type asks before replacing a summary, and saves the type first`.

#### Step 9. Library says DIDN'T FINISH; the record screen explains an ending; merging asks

**Tests first.**

1. `src/screens/__tests__/LibraryScreen.test.tsx`, append (uses the file's own `focusTheLibrary`):
   ```tsx
   test('a crashed meeting reads DIDN\'T FINISH with its reason, not NO SPEECH', async () => {
     (db.listMeetings as jest.Mock).mockResolvedValue([
       {
         id: 'f1', title: 'Crashed', createdAt: Date.now(), durationMs: 600_000, status: 'failed',
         tierUsed: 'free', audioRetained: 1, language: 'en',
         failReason: 'The phone ran out of memory while processing.',
       },
     ]);
     const tree = await focusTheLibrary();
     const text = JSON.stringify(tree.toJSON());
     expect(text).toContain("DIDN'T FINISH");
     expect(text).toContain('ran out of memory');
     expect(text).not.toContain('NO SPEECH');
     await act(async () => tree.unmount());
   });
   ```
2. `src/screens/__tests__/SpeakersScreen.test.tsx`: in `beforeEach` add
   `(db.mergeSpeakers as jest.Mock).mockResolvedValue(undefined);`, and append:
   ```tsx
   test('merging names both speakers and asks first', async () => {
     const tree = await render();
     await act(async () => {
       tree.root.findByProps({ accessibilityLabel: 'Merge Speaker 2 into the kept speaker' }).props.onPress();
     });
     const call = (Alert.alert as jest.Mock).mock.calls[0];
     expect(call[0]).toBe('Merge Speaker 2 into Speaker 1?');
     expect(db.mergeSpeakers).not.toHaveBeenCalled();
     await act(async () => {
       call[2].find((b: { text: string }) => b.text === 'Merge').onPress();
     });
     expect(db.mergeSpeakers).toHaveBeenCalledWith('m1', 's1', 's2');
   });
   ```
3. `npx jest src/screens/__tests__/LibraryScreen.test.tsx src/screens/__tests__/SpeakersScreen.test.tsx --silent --forceExit 2>&1 | grep -E "Tests:|✕" | tail -8` → the two new tests fail.

**Code.**

4. `src/screens/LibraryScreen.tsx` `statusOf`, after the `case 'error':` return (line 47) add:
   ```tsx
       // A crash, which used to wear NO SPEECH. Not live: nothing is running until it is retried.
       case 'failed':
         return { label: "DIDN'T FINISH", color: c.danger, soft: c.dangerSoft, live: false };
   ```
   and in `subtitleOf`, after the `case 'diarized':` return (line 83) add:
   ```tsx
       case 'failed':
         return m.failReason ?? 'Processing stopped. Open it to try again.';
   ```
5. `src/screens/SpeakersScreen.tsx`: add `import { confirmDestructive } from '../components/confirm';`
   below `import { entitlement } from '../billing/trial';`, and replace `merge` (lines 87–91) with:
   ```tsx
     // One tap used to merge, and the dropped speaker's row is deleted — so name both and ask.
     const merge = (dropId: string) => {
       const keep = speakers.find(x => x.id === target);
       const drop = speakers.find(x => x.id === dropId);
       if (!keep || !drop || keep.id === drop.id) return;
       confirmDestructive({
         title: `Merge ${drop.displayName} into ${keep.displayName}?`,
         message: `Everything ${drop.displayName} said will be marked as ${keep.displayName}. This cannot be undone.`,
         confirmLabel: 'Merge',
         onConfirm: async () => {
           await db.mergeSpeakers(meetingId, keep.id, drop.id);
           load();
         },
       });
     };
   ```
6. `src/screens/RecordScreen.tsx`:
   - `warningText` (lines 72–80): after the `case 'loud':` return add
     ```ts
         case 'unannounced':
           return 'The announcement was not heard — tell the room you are recording.';
     ```
     and change its KDoc to `/** The sentences the record screen may show, matching the notification's (strings.xml). */`.
   - add `import { endingNote } from './meeting/meetingNotes';` below
     `import { provenanceLabel } from './meeting/ItemProvenance';` (line 22).
   - replace the `useEffect` that subscribes to `onCaptureState` (lines 197–210, grep
     `emitter.addListener('onCaptureState'`) with:
     ```tsx
       // Set while this screen's own Stop is in flight: that ending is the person's own, and the
       // Meeting screen it opens says the rest.
       const stoppingRef = useRef(false);

       // The recording ended while this screen was open and nobody here pressed Stop: the free limit,
       // a lost mic, a full disk. Say why, make sure it is processing, and offer the meeting.
       const explainEnding = useCallback(
         async (meetingId: string) => {
           const m = await db.getMeeting(meetingId).catch(() => undefined);
           const note = endingNote(m?.endReason, m?.durationMs ?? 0);
           if (!m || !note) return;
           if (m.durationMs > 0) PipelineController.process(meetingId, { model: 'base' }).catch(() => {});
           Alert.alert(
             'Recording stopped',
             note,
             m.durationMs > 0
               ? [
                   {
                     text: 'Open the meeting',
                     onPress: () =>
                       navigation.reset({
                         index: 1,
                         routes: [{ name: 'Library' }, { name: 'Meeting', params: { meetingId } }],
                       }),
                   },
                 ]
               : [{ text: 'OK' }],
           );
         },
         [navigation],
       );

       // Native owns capture state: a meeting can be started from the floating bubble and can outlive
       // the JS context, so re-read on mount and on every resume.
       //
       // `onCaptureState` covers the case resume cannot: this screen is already open and visible when
       // the recording ends somewhere else — Stop on the notification, the free limit, a lost mic.
       useEffect(() => {
         sync();
         const emitter = new NativeEventEmitter(NativeModules.AudioPipeline);
         const state = emitter.addListener('onCaptureState', () => {
           const before = useRecordingStore.getState();
           const ended = before.isRecording ? before.sessionId : null;
           sync().then(() => {
             if (ended && !stoppingRef.current && !useRecordingStore.getState().isRecording) {
               explainEnding(ended);
             }
           });
         });
         const sub = AppState.addEventListener('change', a => {
           if (a === 'active') sync();
         });
         return () => {
           state.remove();
           sub.remove();
         };
       }, [sync, explainEnding]);
     ```
   - in `onToggle`, replace `        const meetingId = await stop();` with
     ```tsx
             stoppingRef.current = true;
             const meetingId = await stop().finally(() => {
               stoppingRef.current = false;
             });
     ```
7. Run the jest command from 3 → all pass; `npx tsc --noEmit 2>&1 | tail -5` → nothing.

**Mutant M10:** in `statusOf` delete the `case 'failed':` return (both lines) → *a crashed meeting
reads DIDN'T FINISH…* fails. Restore. **Mutant M11:** replace `confirmDestructive({ … });` in
`merge` with `db.mergeSpeakers(meetingId, keep.id, drop.id).then(load);` → *merging names both
speakers and asks first* fails. Restore. RecordScreen has no test suite: no mutant; `tsc` only.

Commit: `fix(library,record,speakers): a crash reads DIDN'T FINISH; an ending is explained; merging asks first`.

#### Step 10. Gate, release build, report

1. `GATE_STAGES="types js scans mutations kotlin cpp" scripts/gate.sh 2>&1 | grep -E "==>|ok |FAILED|gate:" | tail -20`
   → every stage `ok`. Force Kotlin:
   `cd android && ./gradlew :app:testDebugUnitTest --rerun-tasks 2>&1 | grep -E "BUILD|FAILED" | tail -3`.
2. `cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a 2>&1 | grep -E "BUILD|FAILED|error:" | tail -5`
   → `BUILD SUCCESSFUL`.
3. `git grep -n "clearNarration" -- src/screens` → nothing. `git grep -n "notif_cap_reached" -- android` → nothing.
   `git diff --stat $(git log -1 --format=%h -- docs/superpowers/specs/2026-09-25-phase-b-nothing-lost-nothing-false-execution.md)..HEAD`
   (the sheet's own last commit, so earlier hotfixes are not counted) names only the files in §1,
   Step 4b's `AnnouncementSpan.kt` and `AnnouncementSpanTest.kt`, the new files
   (`FailureReason.kt`, `FailureReasonTest.kt`, `EndNotice.kt`, `EndNoticeTest.kt`,
   `src/db/__tests__/pendingMeetings.test.ts`, `src/screens/meeting/meetingNotes.ts` and its test),
   `src/screens/meeting/SummaryTab.tsx`'s test, the progress file, the report, and this sheet.
4. Write the report (§8), delete the progress file, commit:
   `docs(report): Phase B — nothing lost, nothing false — built, by-hand steps`.

---

## 4. Expected interfaces after this sheet

- `meetings` has `end_reason`, `fail_reason`, `fail_count` (default 0), `announce_outcome`.
- `MeetingStatus` includes `'failed'`; `Meeting` has `endReason`, `failReason`, `announceOutcome`.
- `PENDING_MEETINGS_SQL`, `EMPTY_MEETINGS_SQL` exported from `src/db/queries.ts`.
- `AudioDb.markFailed(id, reason)`, `setEndReason(id, reason)`, `setAnnounceOutcome(id, outcome)`.
- `FailureReason.of(Throwable): String`, `FailureReason.FALLBACK`.
- `EndNotice.stored / shouldProcess / of`; `RecordingService.END_WRITE_FAILED`, `END_MIC_UNAVAILABLE`.
- `CaptureWarnings.Kind.UNANNOUNCED`, `pick(..., unannounced = false)`, `unannouncedShowing`,
  `UNANNOUNCED_SHOW_MS = 120_000`; `CaptureController.unannouncedAtMs`, `noteAnnouncement(outcome)`.
- `src/screens/meeting/meetingNotes.ts`: `endingNote`, `announceLine`, `holdFor`, `type Hold`.
- `MeetingScreen`: `onReprocess()` takes no argument; `onRewrite()` passes `force: true`.
- `SummaryTab` prop `onChangeTemplate?: (id: string) => void | Promise<void>`.

## 5. Tests and commands

| Command | Must print |
|---|---|
| `npx jest src/db --silent 2>&1 \| tail -5` | all passed |
| `npx jest src/screens --silent --forceExit 2>&1 \| tail -5` | all passed |
| `npx tsc --noEmit 2>&1 \| tail -5` | nothing |
| `cd android && ./gradlew :app:testDebugUnitTest --rerun-tasks 2>&1 \| grep -E "BUILD\|FAILED" \| tail -3` | `BUILD SUCCESSFUL` |
| gate (Steps 5 and 10) | every stage `ok` |
| `assembleRelease` (Step 10) | `BUILD SUCCESSFUL` |

Mutants M1–M12, each killed by its named test and restored.

## 6. Acceptance criteria

- §5 as stated; eleven mutants killed and recorded.
- `git grep -n "setFailure\|onReprocess(true)" -- src` → nothing.
- `git grep -n "clearNarration" -- src/screens` → nothing.
- `git grep -n "notif_cap_reached" -- android` → nothing.
- File set as in Step 10.3; `git status` clean.

## 7. Stop conditions

- A step needs a change in a §2 file: stop, write what and why in the progress file, commit.
- Two unsuccessful fixes of the same failing test or compile error: stop, record both attempts, commit.
- A gate stage fails in a file this session did not touch: do not investigate; record the last 20
  lines, commit.
- At 150 steps: finish the current step, commit, update the progress file, stop.

## 8. The report contract

`docs/superpowers/reports/2026-09-25-phase-b-nothing-lost-nothing-false.md`: status in one line;
what was built per step with hashes; decisions with causes; tests table (name, result, mutant,
result); gate + assembleRelease; device: "not run — founder's by-hand session"; then §7 below
verbatim; known gaps (at least: the background start of processing after a non-Stop ending is
unverified on a phone; `ProcessingEngine`'s `markFailed` call has no JVM test — only the device
can crash a run); `git log --oneline 1a23715..HEAD`. If something was not run, say so.

**§7 — By hand, for the founder** (a new internal-testing build, version bumped past the Phase A
one):

1. **Free limit, screen off.** On Free, start recording and lock the phone; wait past 15 minutes.
   The notification reads *Stopped at the 15-minute Free limit* and EITHER *It is being transcribed
   now.* OR *Open Verbale to transcribe it.* — **note which**: it answers whether Android lets the
   app start processing from the background. Open the app: the meeting processes (or is done)
   without pressing anything, and reads *Stopped at the Free limit. Everything up to that point is
   kept.*
2. **Same, screen on.** Stay on the Record screen past the limit: an alert *Recording stopped* with
   *Open the meeting*.
3. **Tile Stop.** Start a recording, stop it from the Quick Settings tile, do not open the app: a
   *Notes ready* notification arrives in due course.
4. **Announcement not heard.** Media volume to zero, start recording: within seconds the Record
   screen and the notification say *The announcement was not heard — tell the room you are
   recording.*; after about two minutes they stop saying it. The meeting reads *Not announced: the
   phone was on silent.* With the volume up, a new meeting reads *Announced at the start of the
   recording.*
5. **Waiting, not silent.** Record two short meetings back to back and open the second while the
   first is processing: it reads *Writing your notes…* or *Not transcribed yet* with *Process now* —
   never *could not hear any speech*.
6. **Write it again.** On Pro, open a meeting with a summary, tap *Write it again*: the summary
   stays on screen while the button reads *Working…*, and is replaced when the new one is ready.
   Change the type to *Stand-up*: it asks *Change to Stand-up?*; *Cancel* changes nothing; *Change*
   keeps the summary until the stand-up version replaces it.
7. **Merge.** Speakers → merge a speaker: it asks *Merge Speaker 2 into Speaker 1?*; *Cancel* keeps
   both.

## 9. The prompts that start each session

Session B1:

> Read `docs/superpowers/specs/2026-09-25-phase-b-nothing-lost-nothing-false-execution.md` and
> execute Session B1 exactly as written: Steps 1–5 including Step 4b, under its token rules. Stop after committing
> Step 5 and the progress file, when a stop condition is met, or at 150 steps. Do not push.

Session B2:

> Read `docs/superpowers/specs/2026-09-25-phase-b-nothing-lost-nothing-false-execution.md` and then
> `docs/superpowers/reports/phase-b-progress.md`. Execute Session B2 exactly as written: Steps
> 6–10, under its token rules. Stop when the report is committed, when a stop condition is met, or
> at 150 steps. Do not push.

## 10. Deliberately NOT in this sheet

- `mergeSpeakers` is two statements with no transaction and writes no `edits` rows, so a merge does
  not survive re-diarization the way a line repair does (`setLineSpeaker`). B6 is the confirm only.
- A "waiting for the speech model" state distinct from "queued": the database cannot tell them
  apart today (both are `vad`/`captured`); the waiting copy covers both honestly.
- The six-hour FGS limit on the recorder (no `onTimeout` exists on `RecordingService`).
- Resetting `fail_count` after a success.
- Showing the ending reason on the Library card (the meeting shows it).
