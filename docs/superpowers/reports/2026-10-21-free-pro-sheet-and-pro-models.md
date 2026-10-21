# Report: Free-and-Pro sheet, Pro's models in the background (21 Oct 2026)

Branch `pro-models-and-free-sheet`, base `c6e4886`. Steps 1-9 built as written; nothing pushed, no adb.

## 1. Commits

- b6e0d49 feat(billing): proToFetch - the Pro models this phone still needs, smallest first
- 99b7742 feat(billing): planCompare - Free beside Pro, only what this phone runs
- cdc0824 feat(library): ProCompareSheet - Free beside Pro, and Get Pro
- 5063ad5 feat(library): the count opens Free-and-Pro; the Pro pill is gone
- 0984819 feat(setup): proModels - Pro's download as one background run
- d352280 feat(library): Pro's models download by themselves, with a card that says how far
- ee4a2a0 feat(paywall): buying Pro starts Pro's models downloading in the background
- 7f68eff feat(settings): Pro's models are not downloads to manage on Pro; rows say what, not which model
- b23a6e0 feat(onboarding): the writer is part of Pro, not a switch

## 2. Test and gate output

`GATE_STAGES="types js scans" scripts/gate.sh`: types ok, js 130 suites / 1307 tests passed, scans ok,
"gate: all clear in 22s". `npx tsc --noEmit` clean after steps 4, 6, 7, 8, 9.

`git grep "Whisper small|Qwen3 4B|Qwen2.5"` over `src` (excluding legal, tests, graphify-out) printed nothing.

## 3. Mutants

| Step | Mutant | Killed by |
|---|---|---|
| 1 | delete `.sort(...)` | test 1 |
| 1 | delete `&& !m.installed` | tests 1 and 2 |
| 2 | `if (smallRuns)` to `if (true)` | test 2 |
| 3 | `writer: true` | test 1 |
| 4 | AllowanceLine back to `navigate('Paywall')` | first test in (c) |
| 5 | delete setup-download guard | "never runs beside" |
| 5 | `e.downloaded` without `doneBytes +` | "reports the whole run" |
| 5 | delete `autoTried = true;` | "once per launch" |
| 6 | `autoStartProModels(true)` | "on Free it does not", only after the test fix in section 4 |
| 7 | drop `&& route.params?.from !== 'onboarding'` | "leaves the download to setup" |
| 7 | the picking-up `useEffect` body emptied | "buying starts the download" and "opened on Pro" |
| 8 | `off || included` to `off` | both Pro tests |
| 8 | `{m.name} ·{' '}` put back | name test and the five meta tests |

## 4. Deviations

1. Step 6 test "on Free it does not": as written it did not kill its mutant, because `ModelManager.list` returned `[]`
   in that test, so a wrongly started run had nothing to fetch. I added a whisper-small Pro row to that test's list mock.
2. Step 7 mutant (b), "delete the useEffect": I emptied its body instead of deleting the hook (equivalent; hook order stays valid).
3. Step 7: removing the progress listener and `fetchWriter` left `NativeEventEmitter`/`NativeModules` imports unused (eslint error); removed them.
   The `scroller` ref is still attached to the ScrollView but no longer scrolled to; left as is.
4. The sheet file itself differs between `e38c958` and the base `c6e4886`, so `git diff e38c958..HEAD` also lists the spec file.

## 5. Left

- `prettier --check` already flagged `SettingsScreen.tsx` at HEAD before my edits; not touched.
- A pre-existing eslint no-shadow warning in PaywallScreen (`r`) remains.
- No device verification (no adb allowed).
