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
