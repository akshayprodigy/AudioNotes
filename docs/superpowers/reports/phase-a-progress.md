# Phase A progress — buying works, and the app always knows you are Pro

Against `docs/superpowers/specs/2026-09-24-phase-a-buying-and-pro-state-execution.md`, starting at `9c2edd5`.

## Steps

- [x] 1. Server: at the device limit, the least recently seen device makes room
- [x] 2. `redeem` says what actually happened
- [x] 3. `syncEntitlement` — Pro matches Play on every launch and return
- [x] 4. The app runs it on launch and on every return
- [x] 5. Settings: Subscribe opens the Pro screen; Manage for everyone; fresh on focus
- [x] 6. The Pro screen: purchase outcomes said honestly, and Restore
- [x] 7. The record screen's trial button says the same
- [x] 8. Lapsed: "Check again" and "Manage in Google Play"; the sentence stops over-claiming
- [x] 9. The Library notices Pro the moment you come back
- [ ] 10. Gate, release build, report

## Decisions

- Step 1: `tests/test_play.py::test_the_device_limit_applies_to_play_purchases_too` also asserted
  the old 409-refusal (not named in §1's file list). Renamed to
  `test_a_play_purchase_still_links_past_the_device_limit` and updated to expect 200 + a token, per
  the sheet's "if another test asserted the old refusal, update only its expectation" rule.
- Step 3 / Mutant M3: deleting `if (status?.paid) return;` did NOT fail *asks Play nothing when
  this install already has Pro*, contrary to the sheet. Cause: `jest.setup.js`'s
  `Billing: { available: jest.fn().mockResolvedValue(false), … }` default, combined with
  `jest.clearAllMocks()` in this file's `beforeEach` — which clears call history, not mocked
  implementations. That test never sets `Billing.available` itself, so `playAvailable()` already
  resolves `false` regardless of the paid-check, and the very next line
  (`if (!(await playAvailable())) return;`) returns first either way — even run in isolation with
  `-t`, ruling out cross-test leakage as the sole cause. The code was restored to match the sheet
  exactly (the check is correct and needed; this is a test-suite gap, not a reason to add a check
  the sheet didn't ask for). Not fixed — the sheet's file list for Step 3 is only
  `playPurchase.test.ts`/`subscription.ts`, and widening the mock setup is outside that scope.
- Step 4's commit was never made by Session A1 (`App.tsx` and this file were left modified but
  uncommitted, despite this file's own prior note claiming otherwise). Session A2 committed it
  first, verbatim as the sheet's Step 4 message, before starting Step 5.
- Step 5.2: the sheet says replace the effect's comment's "first sentence" with the new one-line
  text, but the original comment's second sentence ("Both calls are cheap and both fail closed…")
  described the now-deleted `playPrice()` call and would be stale and redundant with the new
  sentence if kept. Replaced the whole two-line comment with the one line given, rather than
  literally keeping a now-inaccurate second sentence.

## Mutants

- M1: `server/app/store.py` `touch_device` — put `return False` back as the first line inside
  `if count >= DEVICE_LIMIT:`. All three named tests failed, plus the test_play.py one above (same
  rule, not anticipated by the sheet). Restored; full suite green (195 passed).
- M2: `src/billing/subscription.ts` `redeem` — changed `status >= 500` to `status > 999`. Exactly
  *a server or Google failure (5xx)…* failed (1 of 15). Restored; all 15 green.
- M3 did NOT kill its named test, code restored as-specified anyway (see Decisions).
- M4: `src/screens/PaywallScreen.tsx` `onBuy` — deleted the `if (notice) { … return; }` block.
  Exactly *a payment the server has not confirmed says "Payment received", not failed* failed (1 of
  7). Restored; all 7 green.
- M5: `src/screens/meeting/SummaryTab.tsx` — changed
  `{!prose && reason === 'expired' ? lapsedActions : null}` to `{null}`. Exactly *offers Check again
  and Manage, and Check again asks Play again* failed (1 of 25). Restored; all 25 green.
- M6: `src/screens/LibraryScreen.tsx` `onFocus` — deleted the
  `entitlement().then(e => setPaid(e.paid)).catch(() => {});` line. Exactly *buying Pro on the Pro
  screen is noticed when the library is focused again* failed (1 of 17). Restored; all 17 green.

Step 4: `npx tsc --noEmit` clean; full `npx jest --silent` — 65 suites, 624 tests, all passed.
Step 5: `npx tsc --noEmit` clean. No mutant named for this step (no test suite covers Settings'
purchase button).
Step 6: `npx jest src/billing/__tests__/purchaseNotice.test.ts src/screens/__tests__/PaywallScreen.test.tsx`
— 10 passed; `npx tsc --noEmit` clean.
Step 7: `npx tsc --noEmit` clean. No mutant named for this step (no test suite covers RecordScreen's
trial button).
Step 8: `npx jest src/screens/meeting --silent` — 25 passed; `npx tsc --noEmit` clean;
`cd android && ./gradlew :app:testDebugUnitTest` — BUILD SUCCESSFUL.
Step 9: `npx jest src/screens/__tests__/LibraryScreen.test.tsx --silent` — 17 passed; `npx tsc
--noEmit` clean. This suite needs `--forceExit`: it leaves an open handle after all tests finish
("Jest did not exit one second after the test run has completed") and otherwise hangs for minutes
before the process is killed. Reproduces on the pre-Step-9 code too (confirmed by an accidental
stale run against the unmodified file), so it predates this session and is not Step 9's file list —
not investigated. Worth a look before Step 10's gate run, which does not pass `--forceExit`.

## Notes for the next session

Session A1 (Steps 1–4) complete and committed. Session A2 Steps 5–9 complete and committed,
`git status` clean. Continue at Step 10.
