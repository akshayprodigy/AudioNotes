# Phase A — buying and Pro state — built, by-hand steps

**Status: built, tested, and packaged. Nothing device-verified — that is the founder's by-hand
session (§7 below).**

Against `docs/superpowers/specs/2026-09-24-phase-a-buying-and-pro-state-execution.md`, starting at
`c6caccf`. Two sessions (A1: Steps 1–4, A2: Steps 5–10), no device in either.

## What was built, per step

1. **Server: at the device limit, the least recently seen device makes room** — `73c5431`. A
   reinstall is a new device id; refusing a fourth one for good locked paying customers out.
   `touch_device` now always succeeds, evicting the stalest row at the limit.
2. **`redeem` says what actually happened** — `1885496`. Network failure or 5xx →
   `{ paid: false, pendingServer: true }` (acknowledged, redeemed later); 402 →
   `{ paid: false, pendingPayment: true }` (not acknowledged); any other 4xx → thrown with the
   server's message.
3. **`syncEntitlement`** — `b353b27`. Pro is checked against Play on launch and on every return to
   the foreground, one at a time (a shared in-flight promise), and never throws.
4. **The app runs it on launch and on every return** — `3b9c57e`. `App.tsx` calls
   `syncEntitlement` on mount and on every `AppState` → `active`.
5. **Settings: Subscribe opens the Pro screen; Manage for everyone; fresh on focus** — `0e88506`.
   The old `onBuy` (which called `buyWithPlay()` with no plan and could never buy) is gone;
   Subscribe navigates to Paywall, Manage in Google Play is shown on Free, and the licence and
   entitlement are re-read on every focus.
6. **The Pro screen: purchase outcomes said honestly, and Restore** — `259d651`. New
   `src/billing/purchaseNotice.ts` turns a `pendingServer`/`pendingPayment` result into copy; the
   Pro screen shows it instead of claiming failure, and gained a Restore button.
7. **The record screen's trial button says the same** — `bbe1558`. Same `purchaseNotice` call
   after the cap card's purchase.
8. **Lapsed: "Check again" and "Manage in Google Play"; the sentence stops over-claiming** —
   `92cdffd`. A lapsed Summary tab offers both actions; Check again re-runs `syncEntitlement` and
   re-reads the licence; the native default copy no longer claims the subscription has ended when
   the phone may simply have failed to check.
9. **The Library notices Pro the moment you come back** — `9a57e65`. `entitlement()` is re-read on
   every focus, not only when the finished-meeting count moves, so Search/Actions/Threads unlock
   immediately after buying on the Pro screen.
10. **Gate, release build, report** — `d604041` (pre-work) + this commit. See below.

## Decisions (with causes)

- **Step 1:** `server/tests/test_play.py::test_the_device_limit_applies_to_play_purchases_too` also
  asserted the old 409-refusal, though it wasn't in §1's file list. Renamed to
  `test_a_play_purchase_still_links_past_the_device_limit` and updated to expect 200 + a token, per
  the sheet's "if another test asserted the old refusal, update only its expectation" rule.
- **Step 3 / Mutant M3 did not fail its test** — see *Mutants* below for the cause; this is not a
  gap in the shipped behavior.
- **Step 4's commit was never made by Session A1**; `App.tsx` was left modified but uncommitted.
  Session A2 committed it first, verbatim as the sheet's Step 4 message, before starting Step 5.
- **Step 5.2:** the sheet says replace the effect comment's "first sentence"; the original second
  sentence described the now-deleted `playPrice()` call and would have been stale if kept, so the
  whole two-line comment was replaced with the one line given.
- **Before Step 10, the Reconciler restore:** `git status` showed
  `android/app/src/main/java/com/innocorelabs/verbale/pipeline/Reconciler.kt` modified —
  `CONFIDENT_SIMILARITY` at `0.5` instead of `0.6`, and `if (old.kind != item.kind) continue`
  replaced with `if (false) continue`. These are two leftover mutants from an interrupted run of
  `scripts/mutate-reconciler.py` (a gate mutation-testing stage killed mid-run in an earlier
  session), not real changes, and not called for by any step in this sheet. Restored with
  `git checkout -- android/app/src/main/java/com/innocorelabs/verbale/pipeline/Reconciler.kt`
  before touching anything else in this session; `git status` was clean immediately afterwards.
- **The open-handle investigation (before Step 10):** Step 9's note in the progress file said
  `LibraryScreen.test.tsx` hangs without `--forceExit`. Investigated, two attempts, test file only,
  no product-code change:
  - *Attempt 1* — ran `npx jest src/screens/__tests__/LibraryScreen.test.tsx --detectOpenHandles`
    (five runs total, with and without `--silent`). Every run passed 17/17 and exited cleanly in
    1–4 s; no "open handle" warning, no "did not exit" message. The hang did not reproduce in
    isolation.
  - *Attempt 2* — ran the full suite exactly as the gate's `js` stage does (`npx jest --silent`),
    in case the leak only shows with other files present. It finished in ~8 s with exit code 0 — no
    hang — but did print one real leak warning: *"A worker process has failed to exit
    gracefully… tests leaking due to improper teardown"*, with a stack trace
    (`ReferenceError: … Jest environment … after it has been torn down`, at
    `@react-native/jest-preset/jest/setup.js:51`) naming `src/screens/__tests__/ActionsScreen.test.tsx`
    — not `LibraryScreen.test.tsx`.
  - *Outcome:* the specific claim did not reproduce, in isolation or in the full run, on this
    machine/run. No change was made to `LibraryScreen.test.tsx` — there was nothing reproducible in
    it to fix, and guessing at a fix for an unreproduced symptom would risk masking the real leak,
    which the evidence instead points at a different file. Recorded per the two-attempts rule and
    continued to Step 10. Step 10's gate `js` stage (§ below) ran clean in 6 s, confirming no hang
    there either.
- **Two sheet/reality mismatches found while running Step 10, both harmless, recorded for the next
  session that reuses this sheet:**
  - Step 10.1 as literally written sets a shell variable named `STAGES`, but `scripts/gate.sh`
    reads `GATE_STAGES` (see its own header comment); an unset `GATE_STAGES` falls back to the
    full default list, which includes `device`. The first run this session did exactly that: the
    `device` stage ran, called `adb devices`, found no phone, and returned `ok` in 3 s — no test
    executed, no side effect, but it did touch `adb`, which Rule 0 says never to run. Re-run
    immediately with `GATE_STAGES="types js scans mutations kotlin cpp"`, which excluded `device`
    entirely (confirmed by its absence from the output). All six stages `ok`, `gate: all clear in
    88s`. No file changed as a result of either run.
  - The acceptance check `git grep -n "buyWithPlay()" -- src` does not print nothing: it matches
    five pre-existing calls in `src/billing/__tests__/playPurchase.test.ts` (the original "Play
    purchase path" tests, unchanged by this sheet, exercising `buyWithPlay`'s own default-plan
    behavior). None of the five is a production caller. `grep -n "buyWithPlay" src/screens/SettingsScreen.tsx`
    returns nothing — the A1 bug (`SettingsScreen.tsx:185` calling `buyWithPlay()` with no plan) is
    fixed and there is no other production call site. The acceptance criterion's intent — no
    production caller invokes it bare — holds; its literal command text does not distinguish test
    files from production files.

## Mutants

| # | File / change | Named test | Result |
|---|---|---|---|
| M1 | `server/app/store.py` `touch_device` — `return False` back as the first line inside `if count >= DEVICE_LIMIT:` | the three Step 1 tests | **Killed** (all three failed, plus `test_play.py`'s renamed test — same rule, not anticipated by the sheet). Restored; full suite 195 passed. |
| M2 | `src/billing/subscription.ts` `redeem` — `status >= 500` → `status > 999` | *a server or Google failure (5xx)…* | **Killed** (1 of 15 failed). Restored; all 15 green. |
| M3 | `src/billing/subscription.ts` `syncEntitlement` — delete `if (status?.paid) return;` | *asks Play nothing when this install already has Pro* | **Did not kill.** Cause: `jest.setup.js`'s `Billing.available` default resolves `false`, and `jest.clearAllMocks()` in this file's `beforeEach` clears call history, not mocked implementations — that test never sets `Billing.available` itself, so the very next line (`if (!(await playAvailable())) return;`) returns first regardless of the deleted check, even run in isolation with `-t` (ruling out cross-test leakage). Code restored to match the sheet exactly; the check is correct and needed. This is a test-suite gap (the test doesn't isolate the line it names), not a reason to add an unasked-for check — outside Step 3's file scope (`playPurchase.test.ts` / `subscription.ts` only) to widen. |
| M4 | `src/screens/PaywallScreen.tsx` `onBuy` — delete the `if (notice) { … return; }` block | *a payment the server has not confirmed says "Payment received", not failed* | **Killed** (1 of 7 failed). Restored; all 7 green. |
| M5 | `src/screens/meeting/SummaryTab.tsx` — `{!prose && reason === 'expired' ? lapsedActions : null}` → `{null}` | *offers Check again and Manage, and Check again asks Play again* | **Killed** (1 of 25 failed). Restored; all 25 green. |
| M6 | `src/screens/LibraryScreen.tsx` `onFocus` — delete `entitlement().then(e => setPaid(e.paid)).catch(() => {});` | *buying Pro on the Pro screen is noticed when the library is focused again* | **Killed** (1 of 17 failed). Restored; all 17 green. |

5 of 6 mutants killed by their named test; M3 did not, for the reason above — not a defect in the
shipped code (confirmed by direct restoration + the full suite staying green), but a gap in that
one test's isolation.

## Tests

| Step | Suite / command | Result | Mutant |
|---|---|---|---|
| 1 | `pytest tests/test_store.py tests/test_entitlement.py tests/test_api.py` | 3 replaced tests, all passed; full suite 195 passed | M1 killed |
| 2 | `npx jest src/billing/__tests__/playPurchase.test.ts` | 4 new/changed cases, all passed | M2 killed |
| 3 | same file, `syncEntitlement` describe block | 4 new cases, all passed | M3 not killed (see above) |
| 4 | `npx tsc --noEmit`; `npx jest --silent` | clean; 65 suites / 624 tests passed | no mutant (wiring only) |
| 5 | `npx tsc --noEmit` | clean | no mutant (no test suite covers Settings' purchase button) |
| 6 | `npx jest src/billing/__tests__/purchaseNotice.test.ts src/screens/__tests__/PaywallScreen.test.tsx` | 10 passed | M4 killed |
| 7 | `npx tsc --noEmit` | clean | no mutant (no test suite covers RecordScreen's trial button) |
| 8 | `npx jest src/screens/meeting --silent`; `gradlew :app:testDebugUnitTest` | 25 passed; BUILD SUCCESSFUL | M5 killed |
| 9 | `npx jest src/screens/__tests__/LibraryScreen.test.tsx --silent` | 17 passed | M6 killed |
| 10 | gate + pytest + assembleRelease | see below | — |

## Gate, pytest, assembleRelease (Step 10)

- **Gate** — `GATE_STAGES="types js scans mutations kotlin cpp" scripts/gate.sh`:
  `types` ok (3s), `js` ok (6s), `scans` ok (3s), `mutations` ok (51s), `kotlin` ok (2s), `cpp` ok
  (23s) — `gate: all clear in 88s`. (A first run using the sheet's literal `STAGES=` variable name
  fell back to the gate's default stage list, which includes `device`; see *Decisions* above for
  why that run is not being reported as the qualifying one, and why it was harmless.)
- **Kotlin, forced:** `./gradlew :app:testDebugUnitTest --rerun-tasks` → `BUILD SUCCESSFUL in 20s`.
- **Server:** `cd server && .venv/bin/python -m pytest -q` → `195 passed, 1 warning in 8.87s`.
- **Release build:** `./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a` →
  `BUILD SUCCESSFUL in 1m 16s`. (Only warnings emitted, all pre-existing R8 bytecode-shape notices
  from the third-party `play-services-auth` library, unrelated to this sheet's changes.)
- **File-set check:** `git grep -n "buyWithPlay()" -- src` matches only pre-existing tests, no
  production caller (see *Decisions*); `git grep -n "playPrice" -- src/screens/SettingsScreen.tsx`
  → nothing; `git diff --stat c6caccf..HEAD` names exactly the files in §1 plus
  `src/billing/purchaseNotice.ts` and its test, `server/tests/test_play.py` (explained in
  *Decisions*, Step 1), the progress file, this report, and the two planning docs committed before
  the session.
- **Device:** not run — founder's by-hand session (§7 below).

---

## By hand, for the founder

(server deployed first: `VERBALE_HOST=root@69.62.82.85 server/deploy/deploy.sh`; app = a new
internal-testing build, version bumped):

1. **Settings → See Pro plans** opens the Pro screen with both plans and the trial terms. Settings
   also shows **Manage in Google Play** while on Free.
2. **Payment received:** turn on aeroplane mode AFTER Play's sheet opens, confirm with the tester
   card. The app says **Payment received** (not "could not complete"). Turn the network back on,
   leave the app and return: Pro switches on by itself.
3. **Slow card:** buy with Play's *slow test card*. The app says **Payment still processing**. A few
   minutes later, leave and return to the app: Pro switches on without opening Settings.
4. **Restore:** clear the app's data, open the Pro screen, tap **Restore purchase** → *Subscription
   restored*.
5. **Library:** on Free, buy from the Pro screen, close it: Search/Actions open straight away (no
   paywall).
6. **Lapsed:** cancel the test subscription in Play and let it lapse (test subscriptions end in
   minutes). Open a meeting's Summary: *Pro is off on this phone…* with **Check again** and
   **Manage in Google Play**; Check again says *No active subscription found*.
7. **Reinstall ×3:** uninstall and reinstall from Play three times, Restore each time. The fourth
   install still gets Pro.

---

## Known gaps

- **Mutant M3** did not fail its named test, for the test-isolation reason above (`jest.setup.js`
  default + `clearAllMocks` semantics) — a test-suite gap, not fixed, out of this sheet's file
  scope.
- **The `LibraryScreen.test.tsx` open-handle hang** named in the Step 9 note did not reproduce this
  session (five isolated runs, plus the full suite and the gate's own `js` stage, all clean). The
  full-suite run does show one real leak, but Jest attributes it to
  `src/screens/__tests__/ActionsScreen.test.tsx`, out of this step's scope — worth a look in a
  future session with `--detectOpenHandles` on the full suite, or on the machine/CI where the
  original hang was observed.
- Deliberately not in this sheet (per §10 of the execution sheet): trial-ending/grace/account-hold/
  renewal dates (needs the server to return them — Tier 2); Play purchase updates arriving with no
  purchase flow open (`BillingModule` §2) — `syncEntitlement` on return covers the same cases
  without touching native billing; removing `main.py`'s now-unreachable 409 branches.
- Nothing in this phase has been device-verified; see *By hand, for the founder* above.

## `git log --oneline c6caccf..HEAD`

```
d604041 docs(progress): record Reconciler mutant restore and the open-handle investigation
644a3c4 docs(progress): Step 9 done, M6 recorded; note the pre-existing Jest open-handle hang
9a57e65 fix(library): buying Pro unlocks Search, Actions and Threads straight away
f3e2b32 docs(progress): Step 8 done, M5 recorded
92cdffd fix(summary): a lapsed licence offers Check again and Manage, and stops over-claiming
f3b691d docs(progress): Step 7 done
bbe1558 fix(record): the cap card says "payment received" rather than nothing
4473a54 docs(progress): Step 6 done, M4 recorded
259d651 fix(paywall): a paid-but-unconfirmed purchase says so; Restore on the Pro screen
18083f0 docs(progress): Step 5 done; record the Step 4 dangling-commit and Step 5.2 comment decisions
0e88506 fix(settings): Subscribe opens the plans; Manage in Google Play for everyone; fresh on focus
3b9c57e feat(app): check Pro on launch and on every return to the app
b353b27 feat(billing): syncEntitlement — Pro checked against Play on launch and on return
1885496 fix(billing): a payment that went through is never reported as a failed purchase
73c5431 fix(server): a reinstall can never lock a subscriber out — the stalest device makes room
14156a6 docs(progress): Phase A session A1 progress file
9c2edd5 docs(spec): Phase A file-set check names the two planning docs
8e6ec1b docs(plan): Tier 1 fixes to-do list, and the Phase A execution sheet
```
