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
- Not yet wired (later tasks): `settleAllowance` still uses the old inputs until Task 3.
