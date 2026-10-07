# Free allowance — builder progress (Session 1: Tasks 0, 1b, 3-7)

Branch `dev/october-plan`. Never pushed. Plan: `docs/superpowers/plans/2026-10-07-free-allowance-native.md`; the addendum wins where they differ.

## Task 0 — baseline
- `npx jest src/billing src/screens/__tests__/recordMode.test.ts src/pipeline/__tests__/startRecording.test.ts`: 8 suites, 74 tests, all pass.
- `./gradlew :app:testDebugUnitTest --offline -q`: 359 Kotlin tests, 0 failures. Green baseline.

## Task 1b — addendum rules in the pure policy (R1, R2 policy half, R3, R4 mergeState, R5, R6)
- `AllowancePolicy.settleAction(capturedMs, isDictation, vadDone, speechFound, usableTranscript, processingDone)` is the addendum's eight-row table, first match wins. `Allowance.settle` takes the same inputs.
- `isUsableText` (three words, each with a letter or digit), `nextPeriod`, `readPeriod`, `priority`, `mergeState`, `importVerdict` (+1 s tolerance, `IMPORT_TOLERANCE_MS`), new `PausePolicy` (ask 30 min, end 60 min, `>=` boundaries).
- Signature change: `used`/`remaining` now take the phone's CURRENT period (they compute the effective period and read periods themselves); `Allowance.status` updated.
- Tests added to `AllowancePolicyTest`: five-in-Oct clock Sep and clock Aug denied; Jan-2027 entry read as Oct / Nov / Jan(Dec); forward excursion; refunded entry never moves period; stored period unaffected by time zone; six settle-table tests; usable-text; all nine mergeState pairs; import 3_601_000 / 3_601_001 / 0 / paid. `PausePolicyTest` (4). `AllowanceTest` settle test extended (4 verdicts + a waiting slot stays RESERVED and counts as used).
- Mutants, all killed, restored: dictation row removed; vad no-speech row removed; WAIT->COMMIT at >=60 s; `>=`->`>` on the 60 s COMMIT row; processingDone dropped from usable COMMIT; readPeriod always own period; `>`->`>=` in readPeriod; effectivePeriod ignoring later entries; `used` ignoring read period; mergeState inverted; RESERVED priority 0; import tolerance removed; import `>`->`>=`; usable words 3->2; usable letter filter removed; pause END `>=`->`>`; pause ASK `>=`->`>`; settle REFUND not applied.

## Task 3 — ledger table and AudioDb adapter
- `allowance` table in native `SCHEMA` AND mirrored in `src/db/schema.ts` (the TS schema lists `asks`, so per plan step 1 it lists this too); `schema.test.ts` and `SchemaTest` pin columns and the absence of a foreign key.
- `AudioDb.allowanceStore()`, `settleAllowance(meetingId, processingDone)`, `sweepAllowance()`. `settleAllowance` reads: `meetings.duration_ms`, `mode()` (dictation), `segments` rows (speechFound), `ResumePlan.vadDone(status, speechFound)` (vadDone), and the 3-word usable test over `utterances.text`.
- "No speech" has ONE definition: new `ResumePlan.pastVad(status)` / `vadDone(status, hasSegments)`; `ResumePlan.remaining` now calls `pastVad` (behaviour unchanged, pinned by a test that the planner's terminal-no-speech set equals `vadDone && !segments`).
- `sweepAllowance` treats `done`, `error`, `unsupported_language` as a finished run; `failed` (a crash) is not final and never refunds.
- Tests: `ResumePlanTest` (2 new), `SchemaTest` (1), `schema.test.ts` (1). Mutants killed: vadDone without the `recording` guard (x2), `pastVad` ignoring `failed`, native DDL with a foreign key, TS DDL with a foreign key.
- The SQL itself (transaction, `INSERT OR IGNORE`, the queries) cannot run on the JVM: device-verified later.

## Task 4 — backup carries the ledger, priority merge (R4)
- Bundled SQLCipher 4.6.1 reports SQLite 3.46.1 (strings in the arm64 `.so`), so `ON CONFLICT ... DO UPDATE` is available; no two-step fallback needed.
- `BackupManager.restoreSql(table, columns)`: everything keeps `INSERT OR REPLACE`; `allowance` is an upsert on `id` setting `state` only when the incoming state ranks strictly higher; the CASE priorities are built from `AllowancePolicy.priority` (`statePriority`). `allowance` sits between `settings` and `people` in `TABLES` so the existing "vocabulary last, people before it" test still holds.
- New `data/BackupManagerTest` (4): travels in a backup; other tables still REPLACE; ledger SQL shape (upsert, no REPLACE, period untouched, incoming wins only if higher); SQL priorities equal the policy's.
- Mutants killed: table check bypassed; CASE branches swapped; others' verb changed to IGNORE; `allowance` dropped from TABLES; priorities flattened to 1; `allowance` moved out of TABLES (`SchemaTest`/Backup test).
- Device-verified later: the SQL itself (the JVM cannot run SQLCipher).

## Task 5 — native start reserves a slot and decides the cap; the tile hole is closed
- `AllowancePolicy.capFor(paid)`; `CaptureController.start(context, tier, mode)` has NO cap parameter: it reads `LicenceStore.entitled` (GAP-5), reserves via `Allowance.reserve` (atomic, in the ledger), throws `AllowanceExhausted(resetsOn)` when Free is spent, and refunds the slot if anything between reserve and `startForegroundService` throws (R7: permission, licence, slot, microphone).
- `AudioPipelineModule.start` no longer reads `capMs` (JS still sends it; ignored; `NativeAudioPipeline.ts` untouched for Session 2) and rejects `allowance_exhausted` with `resetsOn` as the message. `ShimActivity.quickStart` opens the app when exhausted. `tsc --noEmit` and `compileDebugAndroidTestKotlin` pass.
- Tests: `CapResolutionTest` (3, including a reflection pin that `start` takes no `Long`); `AllowanceTest` "a start that fails after taking the slot gives it back". Mutants killed: `capFor` swapped, `capFor` always 0, `start` regaining a `Long` cap parameter.
- NOT done here (Task 8 / Session 2): "start refuses while an import is running" and the import-side "recording in progress" check (R5 second half).
- Device-verified later: the tile actually refusing, the foreground-service start failing and refunding.

## Task 6 — one hour, five-minute warning, enforced to the second
- `CapClock.WARN_BEFORE_MS` = 5 min; `src/billing/recordingCap.ts` `FREE_CAP_MS` = 60 min, `WARN_BEFORE_MS` = 5 min (comments updated). `CapClockTest` and `recordingCap.test.ts` rewritten to the hour (tests first: they failed before the constants moved); new CapClock test pins the 5-minute mirror. `EndNoticeTest` uses 60 for the cap-reached sentence.
- `RecordingService` loop: the cap is checked at the 8-read (about 1 s) cadence; the entitlement poll that lifts the cap stays at the 256-read (about 33 s) cadence and now starts five minutes out. The old single block did both on the slow cadence.
- Mutants killed: native `WARN_BEFORE_MS` back to 3 min (2 tests); TS `WARN_BEFORE_MS` 3 min (1 test); TS `FREE_CAP_MS` 15 min (3 tests).
- Not unit-testable: the loop's cadence (device-verified later). Left alone: `notif_cap_warning` reads "Stops at the 60-minute Free limit" from the cap, which is correct; reword in copy work if wanted.

## Task 7 — settle at capture end, at the end of VAD, at the end of the run; R6 pause limits; R7 start order
- `RecordingService` capture end: `db.settleAllowance(id, processingDone = bytes == 0L)` right after `setEndReason` (nothing captured, or a dictation under a minute, refunds at once; anything else stays RESERVED and counted).
- `ProcessingService`: `settleSlot(id)` (= `AudioDb.settleAllowanceAfterRun`) when the VAD stage completes (`onStage("vad", done >= total)`) and on every `onComplete` except `cancelled`. `processingDone` is read from the meeting's STATUS via new `ResumePlan.finished` (done, error, unsupported_language), never assumed, because the engine reports "done" even when ASR has not run (model downloading) and a crash leaves `failed`: neither can refund a short session. Wrapped in try/catch so bookkeeping never interrupts processing.
- Sweep: `AudioPipelineModule.recoverOrphans` (the app-start orphan recovery JS already calls) now runs `sweepAllowance()` afterwards, only when `!CaptureController.isRecording`.
- R6: `CaptureController.currentPauseMs()`; the capture loop (1 s cadence) asks `PausePolicy.action(currentPauseMs())`: ASK sets `pauseAsked` once and re-posts the notification ("Paused for 30 minutes — tap to resume or stop", new string `notif_body_paused_long`), END sets `endReason = END_PAUSE_TIMEOUT` (`"pause_timeout"`), audio kept and queued by the existing path. `EndNotice` sentence "Ended after an hour paused. Everything recorded was kept. <next step>" (and a no-microphone-blame variant when nothing was captured); `meetingNotes.ts` has `pause_timeout: 'Ended after an hour paused'`.
- R7: order permission, licence, slot, microphone is in `CaptureController.start` (Task 5); a failed start refunds via the catch there or via the capture-end settle when `bytes == 0`; an orphan whose service never started is swept (status `error`, duration 0, REFUND). Pure rule is covered by `AllowanceTest` "a start that fails after taking the slot gives it back".
- Tests: `EndNoticeTest` (+2), `ResumePlanTest` (+1), `meetingNotes.test.ts` (+1). Mutants killed: pause notice branch disabled; notice sentence changed; no-capture variant replaced; `finished` including `failed`; `finished` dropping `unsupported_language`; TS `pause_timeout` entry removed.
- NOT unit-testable, device-verified later: the capture loop's pause ask/end, the notification text, `settleAllowance`/`settleAllowanceAfterRun`/`sweepAllowance` SQL, the call sites in `RecordingService` / `ProcessingService`.

## Session 1 close-out
- Gate: `GATE_STAGES="types js scans mutations kotlin" scripts/gate.sh` all clear (types, jest 1983 tests, scans, 33 reconciler mutations caught, Kotlin 394 tests, 0 failures). `:app:compileDebugAndroidTestKotlin` compiles.
- Baseline was 359 Kotlin / 74 targeted jest; added 35 Kotlin tests and a handful of jest tests across Tasks 1b-7.
- Device: not run (no phone used). Everything marked "device-verified later" above is unproven on a phone.
- For Session 2 (Tasks 8-9 and display):
  - `AllowancePolicy.importVerdict(paid, decodedDurationMs)` and `ImportVerdict.TOO_LONG` exist; use the DECODED length. `AllowancePolicy.IMPORT_TOLERANCE_MS` = 1000.
  - R5 second half is NOT done: `CaptureController.start` does not yet refuse while an import runs, and `AudioImport.import` does not yet throw `recording_in_progress`. `ImportModule` serialisation was not checked.
  - `AudioPipelineModule.start` rejects with code `allowance_exhausted` and the reset date `YYYY-MM-DD` as the message. JS still sends `capMs` (ignored natively): remove it from `NativeAudioPipeline.ts`, `PipelineController.startRecording` and `RecordScreen`.
  - JS still decides the cap for DISPLAY via `src/billing/recordingCap.ts` (now 60 min / 5 min, matching `CapClock`).
  - `Allowance.status(...)` (used, remaining, resetsOn, period) is native-only so far; no bridge method exposes it to JS yet.
  - `AllowancePolicy.used/remaining` now take the phone's CURRENT period, not the effective one.
  - A Free import would take its slot through `Allowance.reserve` with the import's meeting id and settle through `AudioDb.settleAllowance` / `settleAllowanceAfterRun` (an import's status path must reach 'captured' with `duration_ms` = decoded length).
  - The notification string `notif_cap_warning` still reads "Stops at the 60-minute Free limit"; copy work may reword.

# Session 2a (Tasks 8-9 JS half, bridge, copy, display, Free keyword search)

## Task 8 / F05 — imports share the allowance (commit: "imports share the allowance")
- `AudioImport.import`: free-space check, then `ImportGate.enter(CaptureController.isRecording)`; then `Allowance.reserve` BEFORE the file is accepted (`LicenceStore.entitled` = paid, Pro takes no slot); the whole body after the reservation is in a try/catch that deletes the temp file and `Allowance.refund`s, so a rejected, undecodable or too-long import costs nothing. `settleAllowance(meetingId, processingDone=false)` runs right after `markCaptured` (try/caught: bookkeeping never fails an import whose audio is safe).
- One-hour refusal three times on the same rule `importVerdict(paid, ms)`: the container's duration before decode, the decoded length as decoding runs (stops early instead of spending minutes), and the final decoded length. Never truncates. `ImportError` now carries a `code`; `ImportModule` rejects with `allowance_exhausted` (message = `YYYY-MM-DD`), `import_too_long` ("That recording is longer than the 1 hour Free limit"), `recording_in_progress` ("Finish recording first"), `import_in_progress` ("Finish the import first"), else `import_failed`.
- NEW `pipeline/ImportGate` (pure, JVM-tested): the one-session-at-a-time rule. It also SERIALISES imports: before this, `ImportModule.pick` only guarded the picker, so a second pick or a share-target `importUri` could decode alongside a running import; the second is now refused with `import_in_progress` (a try-lock, not a queue). `CaptureController.start` returns null and `AudioPipelineModule.start` rejects `import_in_progress` while an import runs. `recoverOrphans` skips `sweepAllowance` while an import runs (its slot exists before its meeting row does).
- Tests: `ImportGateTest` (7). `importVerdict` boundary tests already existed (Session 1). Mutants killed (5): recording branch removed (2 tests), import branch removed, `running` never set (3), `exit` a no-op (6), `blocksStart` always false.
- Device-verified later, NOT run on a phone: the reserve/refund wiring in `AudioImport`, the settle call, the decode-time early refusal, `CaptureController.start` actually returning null during an import (no JVM test reaches it), the SQL.
