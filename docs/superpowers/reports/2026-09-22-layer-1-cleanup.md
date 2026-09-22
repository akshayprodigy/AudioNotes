# Layer 1 cleanup — final report

Against `docs/superpowers/specs/2026-09-22-layer-1-cleanup-execution.md`, `55d8575..HEAD`.

## 1. Status

All nine steps built, tested, mutant-checked and committed; the gate is clear; Session D (the
device checks) was not run — no A07 attached to either session.

## 2. What was built

**Step 1 — a schedule change is a decision.** `isDecision` now also fires when a sentence carries
BOTH a past/passive change verb (`moved`, `pushed`, `postponed`, …) and an explicit new time
(`to Thursday`, `next week`, …) — mirrored in TS and C++. Bare infinitives ("we need to move…")
stay actions. Goldens regenerated and diffed by hand.

**Step 2 — a question needs three words.** `isQuestion` now also requires at least three
ASCII-alnum words (or none at all, for the emoji-only row), so "Okay?", "What?" and "And what?"
stop reading as open questions while a real short question ("Should we revisit pricing?") still
does. Counted as ASCII runs, not `\p{L}`, to keep the C++ `std::regex`-over-bytes port in step.

**Step 3 — inline section labels are still sections.** `foldSections` gained a second branch: when
no line is a bare header but two or more section labels open sentences inside the prose, each
label now starts its own paragraph. One inline label is left alone — it's a sentence, not a shape.
The existing bare-header path is untouched and its test (`foldLeavesAnInlineOpenerAndItsParagraphAlone`)
still passes unchanged.

**Step 4 — the six-hour foreground-service limit.** `ServiceTimeout` (new, pure) decides whether
Android's `onTimeout(startId, fgsType)` callback (API 35+, dataSync FGS, 6h/24h) is worth telling
the person about, and in what words. `ProcessingService.onTimeout` cancels the run at the engine
(stage rows already committed, `ResumePlan` picks it up next sweep), posts the notice, and stops
the service inside the few seconds Android allows before
`ForegroundServiceDidNotStopInTimeException`. No real six-hour timeout was provoked, and no fake
hook was added, per the sheet.

**Step 5 — the card must not offer a trial that is over.** `SummaryTab`'s CTA reads "Get Pro"
whenever `trial.status !== 'unstarted'` (including the undefined/unknown case), and only says "Try
it free for 7 days" while the trial genuinely hasn't started — matching `PaywallScreen`.

**Step 6 — BACK with the keyboard up closes the keyboard.** `TextPrompt` tracks
`keyboardDidShow`/`keyboardDidHide` in a ref and routes the Modal's `onRequestClose` through a new
`onBack`: the first BACK dismisses the keyboard only; a second (keyboard already down) cancels the
prompt. The backdrop tap still cancels directly — it's a decision to leave, not a keyboard
dismissal.

**Step 7 — a sheet never runs off the top of the screen.** `Sheet`'s card is capped at 85% of
`useWindowDimensions().height` (not safe-area insets — `ui.tsx` is rendered in tests with no
`SafeAreaProvider`) and its action rows now scroll in a `ScrollView`; the grip, title and Cancel
sit outside the scroll so they're always reachable.

**Step 8 — the Summary card's header row at 384 dp.** The header row's meta line (`"43 min · 3
speakers"`) is the one element allowed to shrink and ellipsise (`flexShrink: 1`,
`numberOfLines={1}`); the type chip and the Edit/Copy tools (`flexShrink: 0`) never lose
characters, so "Copy" no longer clips to "Co".

**Step 9 — the paywall answers where you are looking.** `PaywallScreen` holds a ref on its
`ScrollView` and scrolls to `{ y: 0, animated: true }` right after `startTrial()` + `load()`
resolve, so the hero line's confirmation is back in view instead of silently changed off-screen
near the bottom.

## 3. Decisions taken

Only one was anticipated by the sheet (9b); the rest are gaps in the sheet, stated plainly rather
than silently patched:

- **Step 9b (anticipated).** The ScrollView's `scrollTo` COULD be spied on through
  `react-test-renderer`: `tree.root.findByType(ScrollView).instance.scrollTo = jest.fn()` works,
  because the RN jest preset's `ScrollView` mock is a class component whose instance carries a real
  `scrollTo`. Used the instance directly, not a mocked `ScrollView` module.
- **Step 5 — a gap in 5b.** `baseProps` in `SummaryTab.test.tsx` had no `onUpgrade`, which the
  `reason === 'locked'` CTA needs to render at all. Added `onUpgrade: jest.fn()` to `baseProps`
  (every pre-existing test now passes it through, unused).
- **Step 8 — the same gap in 8b.** `baseProps` had neither `onEdit` nor `onCopy`, needed for the
  header row's tools to render. Added both as `jest.fn()` to `baseProps`.
- **Step 6 — a bug surfaced by the gate, not the sheet.** The captured-`Keyboard.addListener`
  mock in the new `TextPrompt.test.tsx` tests was typed too narrowly
  (`(event: string, cb: () => void) => …`) and failed `npx tsc --noEmit` in Step 10. Retyped as
  `(...args: unknown[])` with an internal cast; committed separately
  (`fix(prompt): type the captured Keyboard.addListener mock…`) before continuing the gate.

## 4. Tests

| Step | Test | Result | Mutant tried | What the mutant did |
|---|---|---|---|---|
| 1 | `minutes.golden.test.ts` — `kindOf('Shipping moved to Thursday…')` etc. | pass | C++ `isDecision`: `&&` → `\|\|` between SCHEDULE_VERB/SCHEDULE_WHEN | `ctest -R test_minutes` FAILED (10 cascading failures from "I moved to Bangalore last year." now matching). Restored. |
| 1 | same | pass | TS `isDecision`: deleted `SCHEDULE_VERB.test(sentence) &&` | jest FAILED on `kindOf('We need to move the review to Friday')` (expected `'action'`, got `'decision'`). Restored. |
| 2 | `minutes.golden.test.ts` — the `?!?` / `And what?` / `Should we revisit pricing?` rows | pass | C++ `asciiWordCount`: `if (w && !in_word) ++n;` → `if (w) ++n;` | `ctest -R test_minutes` stayed green (spec imprecision — see §8); `ctest -R test_evidence` FAILED (17 failures, "And what?" survives as a question). Restored. |
| 3 | `test_templates.cpp` — `foldSplitsInlineLabelsWhenNoLineIsAHeader`, `foldLeavesASingleInlineLabelInsideProse`, `foldNormalisesTheCasingOfAnInlineLabel` | pass | `if (labelled < 2) return text;` → `if (labelled < 1) return text;` | `ctest -R test_templates` FAILED on `foldLeavesASingleInlineLabelInsideProse`. Restored. |
| 4 | `ServiceTimeoutTest.kt` — all four | pass | `notice`: `if (running == null && queued == 0)` → `if (running == null)` | `testDebugUnitTest` FAILED on `aQueueWithNothingRunningStillSpeaks`. Restored. |
| 5 | `SummaryTab.test.tsx` — "offers the trial…" / "never offers a spent trial" | pass | made the CTA label unconditional | jest FAILED on "never offers a spent trial" (no `Get Pro` rendered). Restored. |
| 6 | `TextPrompt.test.tsx` — "the first BACK closes the keyboard, not the prompt" / "BACK with no keyboard closes the prompt" | pass | deleted the `if (keyboardUp.current)` guard | jest FAILED on the first test (`Keyboard.dismiss` never called). Restored. |
| 7 | `Sheet.test.tsx` — both, plus `MeetingScreen.test.tsx` + `LibraryScreen.test.tsx` regression | pass | removed `maxHeight` from the card's style array | jest FAILED on "a long sheet scrolls instead of growing past the screen" (no ancestor carried `maxHeight`). Restored. |
| 8 | `SummaryTab.test.tsx` — "the meeting meta is the part of the header that shrinks" | pass | dropped `numberOfLines={1}` | jest FAILED (`numberOfLines` undefined). Restored. |
| 9 | `PaywallScreen.test.tsx` — "starting the trial scrolls back to the answer" / "an ended trial is not offered one" | pass | deleted the `scroller.current?.scrollTo(...)` line | jest FAILED on the first test (`scrollTo` never called). Restored. |

Full suite: `npx jest --silent` → **64 suites, 612 tests, all passed.**

## 5. Gate summary

```
==> types
    ok  types (3s)
==> js
    ok  js (5s)
==> scans
    ok  scans (3s)
==> mutations
    ok  mutations (80s)
==> kotlin
    ok  kotlin (3s)
==> cpp
    100% tests passed, 0 tests failed out of 30
    ok  cpp (27s)

gate: all clear in 121s
```

(The `js` stage logs a few "Jest environment torn down" warnings from `ActionsScreen.test.tsx` and
`PaywallScreen.test.tsx`'s async Animated teardown mid-run — pre-existing jest/RN test-runner
noise, not failures; every suite is still marked PASS and the stage returns `ok`.)

## 6. Session D

Not run — device unavailable. No A07 (`R9ZL402YH5A`) was attached to Session A or Session B; both
ran entirely without `adb`, per the sheet's §0 rule for those two sessions.

## 7. For the founder to test by hand

1. Open any meeting and tap ⋮ (the overflow sheet). Look for: the grip and title fully visible
   below the status bar, and all nine rows reachable by scrolling the sheet (Step 7).
2. On the same meeting, long-press a transcript line → "Correct the words" → type something, then
   press BACK once. Look for: the keyboard closes; the prompt and what you typed both stay on
   screen (Step 6).
3. Open a meeting that has a written summary and screenshot the Summary card. Look for: the header
   reads "Copy" in full; the meta line ("43 min · 3 speakers") may be shortened with "…" if the
   screen is narrow (Step 8).
4. In Settings, spend the trial on this phone (all 7 days or all 3 summaries), then open any
   meeting with no summary written yet. Look for: the button reads "Get Pro", never "Try it free
   for 7 days" (Step 5).
5. With the trial already spent, open the Paywall. Look for: "Try Pro free for 7 days" is NOT
   offered. If you ever do a fresh install, tap that button instead and look for: the screen
   scrolls to the top so the hero line's confirmation is what you're looking at (Step 9).

## 8. Known gaps

- **Session D was not run** — needs the A07 physically attached; D1–D5 in the spec are still
  outstanding.
- **Step 4**: a real six-hour foreground-service timeout was not provoked on a bench, and no debug
  hook was added to fake one, per the sheet's own instruction — `ServiceTimeout.notice` is covered
  only by its own unit tests, not by the real Android callback.
- **Step 2's named mutant command is imprecise** (recorded by Session A): the sheet says
  `ctest -R test_minutes` must fail under the `asciiWordCount` mutant; in practice the affected
  fixture row lives only in `evidence_spans.json`, exercised by `test_evidence`, so `test_minutes`
  stays green and `test_evidence` is what actually fails. The mutant still proves the guard; the
  named command in the sheet is what's off. Worth a sheet correction if reused.
- **Two of §6's acceptance checks are stale**, found while verifying them, not caused by Steps 1–9:
  - `grep -c "useBoundsForWidth" android/app/src/main/res/values-v35/styles.xml` returns **2**, not
    1 — the file has always had two occurrences (an explanatory comment plus the real `<item>`).
    `git diff 55d8575..HEAD -- <that file>` is empty: this session touched nothing there.
  - `git diff --stat 55d8575..HEAD` also lists
    `docs/superpowers/specs/2026-09-22-layer-1-cleanup-execution.md`, because the commit that adds
    the spec itself (`7e3de5e`) sits inside that commit range — it's the founder's own prior
    commit, not something Steps 1–9 touched.
- **`docs/superpowers/reports/layer-1-cleanup-progress.md` is deleted** in the same commit as this
  report, per Step 10.4 — it will not appear in a future `git diff --stat` against this point.

## 9. Commits

```
912f6ef fix(prompt): type the captured Keyboard.addListener mock so tsc --noEmit stays silent
3288f61 fix(paywall): starting the trial scrolls back to the sentence that answers it
6e06031 fix(summary): the header row shrinks the meta instead of clipping Copy
36b8488 fix(sheet): nine rows scroll instead of pushing the title off the screen
8cc7998 fix(prompt): BACK closes the keyboard before it closes the prompt
ce8351d fix(summary): a spent trial is not offered again — the card says Get Pro
60b14e2 fix(processing): Android's six-hour limit pauses a meeting instead of killing the app
1e42c1b fix(templates): a section label inside the prose still starts a section
1421038 fix(extractor): "Okay?" is a pause, not an open question — a question needs three words
5e1d5d1 fix(extractor): a date that moved is a decision — "shipping moved to Thursday" now lands in the thread
7e3de5e docs: an execution sheet for the nine open Layer 1 items, in three sessions
```
