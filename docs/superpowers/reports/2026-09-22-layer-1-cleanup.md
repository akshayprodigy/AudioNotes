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

Run this session, on the A07 (`R9ZL402YH5A`), against `HEAD` (`11dd33f`).

**Before running D1–D5: the release APK on the phone was stale and had to be rebuilt.** The APK
already at `android/app/build/outputs/apk/release/app-release.apk` was built 22 Sep 15:07 and
installed on the phone at 15:20 — over ninety minutes **before** the first Layer-1 commit
(`5e1d5d1`, 17:07). None of Steps 1–9 were in that binary. Asked the founder how to proceed;
chosen: rebuild from `HEAD` and reinstall, then run D1–D5 against the real fixes. An unrelated
uncommitted change already in the tree (`android/app/build.gradle`, `appVersionName` dropped to
"0.9.0") was stashed before the build and popped back afterward — untouched, not part of this
sheet. `./gradlew assembleRelease` (`android/`) built clean in 9s; the freshly generated JS bundle
was checked for five fix-specific identifiers before installing —
`trialOffer`, `SHEET_MAX_FRACTION`, `keyboardUp`, `onBack`, `scroller` — all five present in
`android/app/build/intermediates/sourcemaps/react/release/index.android.bundle.packager.map`.
Installed with `adb install -r`; `lastUpdateTime` moved to 19:13:06, after every commit in
`55d8575..HEAD`. D1–D5 below ran against that build. Screenshots for each row are in `/tmp`
(`d1_*.png` … `d5_*.png`); the meeting used for D1–D4 is "The evening and the Friday" (22 Sept,
2:17 pm, `weekly` tag, a `Client call` written summary) unless noted otherwise.

| # | What the phone showed |
|---|---|
| D1 | Opened the meeting, tapped ⋮. The sheet's title ("The evening and the Friday") stayed fully visible below the status bar and the Library header for the whole gesture — it never scrolled with the rows. Scrolling the sheet reached all nine rows in order: Ask this meeting, Speakers, Rename, Add a tag, Export, Copy, Redo, Archive, Delete, with Cancel pinned below them throughout. **Matches Step 7.** (`d1_sheet_top.png`, `d1_sheet_scrolled_archive_delete.png`) |
| D2 | Script tab, long-pressed "Good morning." → "Correct the words" → the prompt opened with that line in the field. Tapped the field, the keyboard came up, typed text in (the field read "Good morning.Testing" — `adb input text`'s handling of the space and the rest of the string is an artifact of the shell command, not the app). Pressed BACK once: the keyboard closed, and the prompt stayed open with the typed text still in the field, untouched. Cancelled the prompt afterward so the meeting was left as found. **Matches Step 6.** (`d2_correct_menu.png`, `d2_prompt_open.png`, `d2_typed_keyboard_up.png`, `d2_after_first_back.png`) |
| D3 | Screenshotted the Summary card on the same meeting. The header row reads `SUMMARY · Client call · 1 min… · [pencil] Edit · [copy icon] Copy` — "Copy" is fully spelled out, and the meta ("1 min · 1 speaker") is what's shortened, to "1 min…" with an ellipsis. **Matches Step 8.** (`d3_summary_card.png`, close-up crop `d3_header_zoom.png`) |
| D4 | Settings → Subscription showed the "Free" tier with a "Subscribe" button and no trial wording anywhere (see D5 below for the confirmation that the trial is spent). Opened a meeting with no written summary yet ("This meeting is being recorded by…", 22 Sept 2:52 pm, still on the locked/generic card). Its CTA reads "Get Pro" — never "Try it free for 7 days". **Matches Step 5.** (`d4_get_pro_no_prose.png`) |
| D5 | Tapping Settings' own "Subscribe" surfaced a Play Billing error ("Could not complete the purchase — No subscription 'verbale_pro' is available… this build was installed from Play") — expected on a sideloaded bench build with no configured Play product ([[production-readiness-2026-09-14]], [[pre-production-build-sequence]]), not a Layer-1 regression. Opened the real Paywall screen instead (Library → Search, Pro-gated). Its hero reads "That was the 3 trial summaries. Everything they wrote is still in your library." — the trial is spent — and "Try Pro free for 7 days" is **not offered anywhere** on the screen; the only CTA is "Subscribe", with copy underneath reading "Nothing was taken away when the trial ended…". **Matches Step 9's "not offered" half.** The other half — fresh install, tap the trial button, watch it scroll to the top — could not be run: this bench device's trial is already spent, and the sheet says not to `pm clear` it without being told to, so no fresh install was made. **Not run: the scroll-on-tap behavior itself, only the "not offered when spent" half.** (`d5_settings_subscribe_playstore_error.png`, `d5_paywall_hero.png`, `d5_paywall_subscribe_only.png`) |

Nothing was fixed. `android/app/build.gradle`'s pre-existing uncommitted change was restored
exactly as found; no other file changed. `git status` is clean except that one pre-existing diff.

## 7. For the founder to test by hand

Session D above already verified D1–D4 and the "not offered" half of D5 on-device, against a
freshly built release APK from `HEAD`. What's left for hand-testing is what this session could not
exercise on the bench A07, plus the one item every session has deferred:

1. **Step 9, the other half.** On a fresh install (trial not yet spent), tap "Try Pro free for 7
   days" on the Paywall and watch the screen. Look for: it scrolls to the top so the hero line's
   confirmation is what you're looking at, not silently changed off-screen near the bottom. Session
   D could only confirm the button is correctly *absent* once the trial is spent — not this.
2. **Step 4, the six-hour foreground-service limit.** Not reachable on a bench per the sheet's own
   instruction (no real 6-hour timeout was provoked, no fake hook added). If a meeting ever runs
   that long in practice: look for a "Paused for today" notification instead of a crash, and that
   reopening the app resumes the meeting from where it stopped rather than losing it.
3. **The Play Store product itself.** D5 hit "No subscription 'verbale_pro' is available… this
   build was installed from Play" the moment Settings' own Subscribe button was tapped — this is
   the same live-server/Play-link gap recorded in [[pre-production-build-sequence]], not something
   this session's fixes touch. Worth a from-Play install once the Play Console side is configured,
   specifically to confirm Subscribe actually opens a billing sheet rather than erroring.
4. Everything else in this sheet (Steps 1–3, the C++ extractor and template rules; Step 4's
   Kotlin unit tests) was verified by the automated gate in §5, not by hand — no device-side
   behaviour is expected to differ, but nobody has watched a real meeting exercise the new
   "shipping moved to Thursday" / "Okay?" / inline-label rules end to end on this phone.

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
