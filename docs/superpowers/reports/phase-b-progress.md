# Phase B progress — nothing is lost, nothing false is said

Against `1a23715`. Execution sheet: `docs/superpowers/specs/2026-09-25-phase-b-nothing-lost-nothing-false-execution.md`.

## Steps

- [x] Step 1. Four columns, the `failed` status, and the sweep that retries it
- [x] Step 2. A crash is `failed`, with a reason, and runs again from where it stopped
- [x] Step 3. Every ending is stored, processed and explained
- [ ] Step 4. The announcement's outcome: stored, and warned about for two minutes
- [ ] Step 4b. (B7) A clip that was FOUND is kept out of ASR, heard or not
- [ ] Step 5. Session B1 gate
- [ ] Step 6. Three pure pieces of copy: endings, the announcement line, what an empty meeting is
- [ ] Step 7. The Meeting screen: never "no speech" unless it is; failed says why; Write it again keeps the summary
- [ ] Step 8. SummaryTab: Pro type change over an existing summary asks first
- [ ] Step 9. Library, Record, Speakers screens
- [ ] Step 10. Session B2 gate + report

## Decisions

(none yet)

## Mutants

- M1: `PENDING_MEETINGS_SQL` `fail_count < 3` → `fail_count < 99` — *a meeting that failed three
  times is left for a person to retry* failed. Restored.
- M2: `ResumePlan.kt` deleted ` && s.status != "failed"` — *aCrashBeforeVadIsRunAgainFromTheStart*
  failed. Restored.
- M3: `FailureReason.of` deleted the `e is OutOfMemoryError ->` branch — *outOfMemoryIsSaidAsMemory*
  failed. Restored.
- M4: `EndNotice.shouldProcess` `capturedBytes > 0L` → `capturedBytes >= 0L` —
  *nothingCapturedIsNothingToProcess* failed. Restored.

## Notes for the next session

(none yet)
