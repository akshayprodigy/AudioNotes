# Pro door on the Library, paywall bought without scrolling — 19 Oct 2026

## 1. What was built

1. `b6fcb45` — `proHighlights` picks the three above-the-fold lines (+4 tests).
2. `126b61b` — `Paywall` route accepts `from: 'export'`; the export gate sends it.
3. `687c948` — Pro screen: pinned dock (plan, button, terms), compact hero, three highlights; the no-trial button states price and period.
4. `dc7e214` — `ProPill` replaces the Actions icon in a Free Library header (hidden until the entitlement is known).
5. `d7a01fa` — the allowance line and the summary strip open the Pro screen on Free.
6. `efa3b75` — test follow-up for Step 2 (see §3).

## 2. Mutants

- Step 1 (`writerRuns ? WRITER : MEANING` -> `WRITER`): killed (test 2 failed).
- Step 3 (dock moved inside the ScrollView): killed (`keeps the buy button and the trial terms outside the scroll` failed).
- Step 4 (pill navigates to `'Actions'`): killed (`on free the header has a "Get Pro" pill...` failed).
- Step 5 (`stats.some(...)` -> `true`): killed (`Pro sees no allowance line` failed).

## 3. Deviations from the sheet

- `src/share/__tests__/ShareProGate.test.tsx` was edited (two expectations now include `from: 'export'`), commit `efa3b75`. Cause: Step 2's change made those two tests fail and the gate's `js` stage must pass; the sheet's file list did not name this test.
- `src/screens/LibraryScreen.tsx` comment near the Threads door said `the "Actions (Pro)" header button is its door`; reworded to `the Pro pill in the header is its door`. Cause: §7 requires `grep -c "Actions (Pro)"` to print 0.
- §7's INCLUDED/FREE_FOREVER grep prints one line (`+    body: { paddingHorizontal: s(20), paddingTop: s(4), paddingBottom: s(24) },`): the mandated `body` style change matches the `body:` pattern. No `INCLUDED` or `FREE_FOREVER` text changed.
- Jest runs for mutants used `--forceExit`; without it a failing LibraryScreen run does not exit (open handles). No effect on results.
- Step 3's render was assembled by script from the old JSX blocks (re-indented, otherwise byte-identical). `prettier --check` flags PaywallScreen.tsx; not part of the gate.

## 4. For the founder to test on a phone

1. Free phone, nothing recorded: the header shows Import, Search, **Pro**, Settings on one row; tapping Pro opens the Pro screen.
2. Tapping "Go unlimited with Pro ›" under the allowance line opens the Pro screen.
3. On the Pro screen at default font size, without scrolling: the title, three highlights, the Yearly/Monthly picker, the "Try it free for 7 days" button and the terms are all visible. Check on the Galaxy A07 (smallest screen).
4. Scrolling moves the feature list; the picker, button and terms stay put.
5. With a recording saved, the summary strip shows "Go unlimited with Pro ›" and opens the Pro screen.
6. On a Pro account: no pill, the Actions icon is back, the strip has no link.
