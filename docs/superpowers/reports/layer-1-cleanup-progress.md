# Layer 1 cleanup — progress

Against `docs/superpowers/specs/2026-09-22-layer-1-cleanup-execution.md`.

## Steps

- [x] Step 1. A schedule change is a decision
- [ ] Step 2. A question needs three words
- [ ] Step 3. Inline section labels are still sections
- [ ] Step 4. The six-hour foreground-service limit
- [ ] Step 5. The card must not offer a trial that is over
- [ ] Step 6. BACK with the keyboard up closes the keyboard
- [ ] Step 7. A sheet never runs off the top of the screen
- [ ] Step 8. The Summary card's header row at 384 dp
- [ ] Step 9. The paywall answers where you are looking

## Decisions

## Mutants

- Step 1, C++: `isDecision` `&&` → `||` between SCHEDULE_VERB/SCHEDULE_WHEN. `ctest -R test_minutes`
  failed (10 assertion failures cascading from "I moved to Bangalore last year." now matching).
  Restored.
- Step 1, TS: deleted `SCHEDULE_VERB.test(sentence) &&` from `isDecision`. jest failed — the
  divergence first surfaced on `kindOf('We need to move the review to Friday')` (expected
  `'action'`, got `'decision'`, because SCHEDULE_WHEN alone now matched "to Friday"), which is the
  same guard the "I moved to Bangalore" row exercises. Restored.

## Notes for the next session
