# Free allowance — addendum (founder decisions, 7 Oct 2026)

Read **with** `2026-10-07-free-allowance-native.md`. Where this file and that plan disagree, **this file wins**: it folds in the founder's decisions and the 14 policy defaults of `docs/PRODUCT_IMPROVEMENT_PLAN_2026-10.md` §3a. It is part of the execution sheet for Session 1 (Tasks 1b, 3–7) and Session 2 (Tasks 8–9 and display).

## Rules that change the code in Tasks 1–2 (already on `main`)

### R1 — a dictation under 60 s of captured audio never takes a slot (founder, GAP-2)
- Meetings under 60 s keep §3's rule (a usable transcript commits; none refunds).
- A dictation of 60 s or more counts like any session.
- `AllowancePolicy.settleAction` gains `isDictation: Boolean`. A dictation with `capturedMs < COMMIT_AFTER_MS` is **REFUND immediately**, with no waiting for processing, whatever the transcript.
- `AudioDb.settleAllowance` reads `meetings.mode` (`'dictation'` or other) and passes it.

### R2 — "empty" is "no speech found", at any length (GAP-2, GAP-3)
- The speech-detection (VAD) stage is cheap (~0.01× real time). Settle at the end of that stage, not at the end of the whole pipeline.
- New inputs to `settleAction`: `vadDone: Boolean`, `speechFound: Boolean` (at least one VAD span stored for the meeting — find where the pipeline stores spans and what "no speech" is read from; reuse the same test the Library uses for `no-speech`; do not invent a second definition).
- Full table (first matching row wins):

| Condition | Verdict |
|---|---|
| `capturedMs <= 0` | REFUND |
| `isDictation && capturedMs < COMMIT_AFTER_MS` | REFUND |
| `vadDone && !speechFound` | REFUND (any length) |
| `capturedMs >= COMMIT_AFTER_MS && vadDone && speechFound` | COMMIT |
| `capturedMs >= COMMIT_AFTER_MS` (VAD not yet done) | WAIT |
| `capturedMs < COMMIT_AFTER_MS`, `processingDone && usableTranscript` | COMMIT |
| `capturedMs < COMMIT_AFTER_MS`, `processingDone && !usableTranscript` | REFUND |
| otherwise | WAIT |

- "Usable transcript" = at least one utterance of **three or more words** (GAP-1). Replace the plain "any utterance row" test in `settleAllowance` accordingly (count words in `utterances.text`; a SQL `LIKE '% % %'` after trimming is acceptable, or read the text and count in Kotlin).
- A WAIT keeps the slot RESERVED, and a RESERVED slot **counts as used** (it already does in `AllowancePolicy.used`). The display therefore shows it as used until settled.
- Call `settleAllowance` again from `ProcessingService` when the VAD stage completes (`onStageComplete("vad")` or the equivalent), and when the run finishes. A crash that will be retried must not refund (the plan's Task 7 rule stays).
- A crash on a short session never refunds by itself: only a *completed* run with no speech or no usable transcript refunds.

### R3 — a counted session far in the future is read as this month (GAP-8)
Replace `effectivePeriod`/`used` logic so that:
- `nextPeriod(p)` is the month after `p` (`"2026-12"` → `"2027-01"`).
- For a counted entry, its **read period** is its own period, unless it is later than `nextPeriod(nowPeriod)`, in which case its read period is `nowPeriod`.
- `effectivePeriod` = the later of `nowPeriod` and the latest *read period* of any counted entry. `used(entries, period)` counts entries by **read period**.
- Keep: a clock wound back up to a month cannot reopen a spent month; a clock wound back further still counts those sessions against the current month (so the user is not given slots); a forward excursion can lock recording for at most the following month.
- Tests (add to `AllowancePolicyTest`): five used in Oct, clock set to Sep → denied, `resetsOn = 2026-11-01`; five used in Oct, clock set to Aug → denied; one session recorded under a clock set to Jan 2027 then clock back to Oct → that entry is read as October (one used, four left), and **in December** it is read as January (next month) — and in **November** it is read as November; a refunded entry never moves the period. Time-zone rule: an entry keeps the period string stored at reservation; nothing re-derives it.

### R4 — backup merge: the state that uses more allowance wins (GAP-9)
- Priority COMMITTED (3) > RESERVED (2) > REFUNDED (1). Add a pure `AllowancePolicy.mergeState(local, incoming)` returning the higher-priority state, with a test table covering all nine pairs.
- Replace plan Task 4's "INSERT OR IGNORE" with an upsert that applies the same priority in SQL: `INSERT INTO main.allowance(id,period,state,reserved_at) SELECT … FROM bak.allowance WHERE true ON CONFLICT(id) DO UPDATE SET state = CASE WHEN <priority(excluded.state)> > <priority(allowance.state)> THEN excluded.state ELSE allowance.state END`. First check the bundled SQLCipher's SQLite version supports `ON CONFLICT … DO UPDATE` (3.24+); if it does not, restore with a two-step (`INSERT OR IGNORE`, then `UPDATE … SET state=` joined to `bak.allowance` where the backup's priority is higher). `BackupManager.restoreVerb` becomes `restoreSql(table)` or similar; keep a unit test that the allowance table uses the priority merge and others keep `INSERT OR REPLACE`. The SQL itself is device-verified later; say so in the progress file.

### R5 — imports (GAP-6, GAP-11, GAP-13)
- `importVerdict(paid, durationMs)`: `TOO_LONG` when `!paid && durationMs > FREE_DURATION_MS + 1_000`. Test 3_601_000 OK, 3_601_001 TOO_LONG, unknown (0) OK, paid any length OK.
- An import's length is its **decoded** length; a container header that disagrees is overruled by the decoded length (plan Task 8 step 3).
- One session at a time: `AudioImport.import` throws `ImportError("recording_in_progress")` if `CaptureController.isRecording`; `CaptureController.start` refuses (returns null, as for `stopping`) while an import is running. Imports already run one after another — check `ImportModule` and keep it that way (add a mutex if it does not). JS shows "Finish recording first" / "Finish the import first".

### R6 — a paused recording does not hold a slot forever (GAP-7)
- New pure `PausePolicy` (in `pipeline/`, next to `CapClock`): `ask after 30 minutes paused, end after 60 minutes paused`; `fun action(pausedForMs): Action { NONE, ASK, END }` with constants and a JVM test of both boundaries.
- Wire into the capture loop where `paused` is handled: at `ASK`, the notification body says "Paused for 30 minutes — tap to resume or stop" (once); at `END`, `endReason = END_PAUSE_TIMEOUT`, audio kept, queued, with an `EndNotice` sentence ("Ended after an hour paused. Everything recorded was kept."). Add the reason to `EndNotice`/`meetingNotes.ts` and tests beside the existing ones.
- Pause time already accumulates in `CaptureController.pausedTotalMs`/`pausedAtMs`; use the current pause only.

### R7 — order at start (GAP-10)
Permission → licence → take a slot → open the microphone. Storage is checked in the service (50 MB); a start that then fails **must refund the slot** — Task 7's `settleAllowance` at capture end does it when `bytes == 0`. Add a JVM test of the pure rule if one can be written; otherwise note that it is device-verified.

### R8 — copy (GAP-12)
`src/billing/allowanceCopy.ts` also exports `explainer = "Imports and dictations count as meetings."` and the three spec strings from plan §3 (remaining, exhausted, headline). Tests pin them.

### Unchanged from the plan, for the record
GAP-4 (a Free session upgraded mid-way keeps its slot), GAP-5 (Pro at start = `LicenceStore.entitled` at the instant of start), GAP-14 (a pending purchase stays Free; the existing lift-the-cap-without-restart poll stays).

## Rules for every builder session

1. **Branch:** work on `dev/october-plan`. Commit per task with the message style used in `git log`. **Never push.**
2. **House rule — mutation-test every new rule:** break it, watch a named test fail, restore. Record each mutant in `docs/superpowers/reports/2026-10-07-allowance-progress.md` (create it; commit it with each task so a fresh session can resume).
3. **Tests first** for pure logic. `cd android && ./gradlew :app:testDebugUnitTest --offline -q` and `npx jest <path> --silent --forceExit`. Pipe long output through `tail`/`grep`.
4. **Do not touch** `cpp/**` (unless a sheet says so), `server/**`, `eval/**`, golden files.
5. **Gate:** at the end run `GATE_STAGES="types js scans mutations kotlin" scripts/gate.sh` (the `cpp` and `device` stages are not needed unless a task touched `cpp`). Fix what you broke; do not investigate failures in files you did not touch — report them.
6. **Stop conditions:** two failed fixes of the same failure → stop and report; an API not in the sheet and not obvious → stop and report; no phone is available → skip every device step and list it under "Device: not run".
7. **Report:** finish by writing/updating the progress file with, per task: commits, tests added (names), mutants (killed/restored), and anything not done. Do not claim a behaviour works on a phone.
