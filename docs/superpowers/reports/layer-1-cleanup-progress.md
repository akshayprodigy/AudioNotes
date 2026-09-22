# Layer 1 cleanup — progress

Against `docs/superpowers/specs/2026-09-22-layer-1-cleanup-execution.md`.

## Steps

- [x] Step 1. A schedule change is a decision
- [x] Step 2. A question needs three words
- [x] Step 3. Inline section labels are still sections
- [x] Step 4. The six-hour foreground-service limit
- [x] Step 5. The card must not offer a trial that is over
- [x] Step 6. BACK with the keyboard up closes the keyboard
- [x] Step 7. A sheet never runs off the top of the screen
- [x] Step 8. The Summary card's header row at 384 dp
- [x] Step 9. The paywall answers where you are looking

## Decisions

- Step 5: the sheet's 5b does not mention that `baseProps` in `SummaryTab.test.tsx` has no
  `onUpgrade`, needed for the `reason === 'locked'` CTA to render at all. Added
  `onUpgrade: jest.fn()` to `baseProps` (every existing test still passes it through unused).
- Step 8: same gap for `onEdit`/`onCopy` — neither was in `baseProps`, and both are needed for the
  header row's tools (Edit, Copy) to render at all. Added both as `jest.fn()` to `baseProps`.
- Step 9b (the one decision the sheet left open): the ScrollView's `scrollTo` COULD be spied on
  through `react-test-renderer` — `tree.root.findByType(ScrollView).instance.scrollTo = jest.fn()`
  works, because RN's jest preset ScrollView mock is a class component whose instance carries a
  real `scrollTo` method. Used the instance directly, not a mocked `ScrollView` module.

## Mutants

- Step 1, C++: `isDecision` `&&` → `||` between SCHEDULE_VERB/SCHEDULE_WHEN. `ctest -R test_minutes`
  failed (10 assertion failures cascading from "I moved to Bangalore last year." now matching).
  Restored.
- Step 1, TS: deleted `SCHEDULE_VERB.test(sentence) &&` from `isDecision`. jest failed — the
  divergence first surfaced on `kindOf('We need to move the review to Friday')` (expected
  `'action'`, got `'decision'`, because SCHEDULE_WHEN alone now matched "to Friday"), which is the
  same guard the "I moved to Bangalore" row exercises. Restored.

- Step 2, C++: `asciiWordCount`'s `if (w && !in_word) ++n;` → `if (w) ++n;` (count characters, not
  words). Sheet says `ctest -R test_minutes` must fail; in practice the affected fixture row ("And
  what?") lives only in SPANS/`evidence_spans.json`, exercised by `test_evidence`, not
  `test_minutes` — `test_minutes` stayed green (no RULES/other minutes-golden row crosses the
  three-word floor under this mutant) while `test_evidence` failed with 17 assertion failures,
  "And what?" surviving as a question. Recorded as a spec imprecision, not a step defect; the
  mutant does prove the guard. Restored.

- Step 3: `if (labelled < 2) return text;` → `if (labelled < 1) return text;`. `ctest -R
  test_templates` failed exactly as named — `foldLeavesASingleInlineLabelInsideProse` (a single
  inline label no longer left alone). Restored.
- Step 4: `ServiceTimeout.notice`'s `if (running == null && queued == 0)` → `if (running == null)`.
  `./gradlew :app:testDebugUnitTest --tests '*ServiceTimeoutTest*'` failed exactly as named —
  `aQueueWithNothingRunningStillSpeaks` (a cleared queue with nothing running went silent).
  Restored.
- Step 5: made the CTA label unconditional again (`` label={`Try it free for ${TRIAL_DAYS} days`} ``).
  `npx jest SummaryTab.test.tsx` failed exactly as named — "never offers a spent trial" (no `Get
  Pro` button rendered). Restored.
- Step 6: deleted the `if (keyboardUp.current)` guard in `onBack`. `npx jest TextPrompt.test.tsx`
  failed exactly as named — "the first BACK closes the keyboard, not the prompt" (`Keyboard.dismiss`
  never called; BACK always fell through to `onCancel`). Restored.
- Step 7: removed `maxHeight` from the card's style array. `npx jest Sheet.test.tsx` failed exactly
  as named — "a long sheet scrolls instead of growing past the screen" (no ancestor of the
  ScrollView carried a `maxHeight` style any more). Restored.
- Step 8: dropped `numberOfLines={1}` from the meta `Txt`. `npx jest SummaryTab.test.tsx` failed
  exactly as named — "the meeting meta is the part of the header that shrinks" (`numberOfLines`
  undefined). Restored.
- Step 9: deleted the `scroller.current?.scrollTo(...)` line. `npx jest PaywallScreen.test.tsx`
  failed exactly as named — "starting the trial scrolls back to the answer" (`scrollTo` never
  called). Restored.

## Notes for the next session

- Step 2's named mutant command in the sheet (`ctest -R test_minutes`) does not exercise the row
  the mutant breaks; `ctest -R test_evidence` (or the combined `"test_minutes|test_evidence"` used
  in the Run step) is what actually fails. Worth a sheet correction if this spec is reused.
- Step 4: a real six-hour foreground-service timeout was NOT provoked and no debug hook was added
  to fake one, per the sheet — not reachable on a bench, and a fake would only test the fake.
  `ServiceTimeout.notice` is covered by its own unit tests instead.
