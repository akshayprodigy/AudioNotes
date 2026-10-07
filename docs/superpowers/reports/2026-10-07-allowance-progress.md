# Free allowance — builder progress (Session 1: Tasks 0, 1b, 3-7)

Branch `dev/october-plan`. Never pushed. Plan: `docs/superpowers/plans/2026-10-07-free-allowance-native.md`; the addendum wins where they differ.

## Task 0 — baseline
- `npx jest src/billing src/screens/__tests__/recordMode.test.ts src/pipeline/__tests__/startRecording.test.ts`: 8 suites, 74 tests, all pass.
- `./gradlew :app:testDebugUnitTest --offline -q`: 359 Kotlin tests, 0 failures. Green baseline.
