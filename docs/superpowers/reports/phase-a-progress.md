# Phase A progress — buying works, and the app always knows you are Pro

Against `docs/superpowers/specs/2026-09-24-phase-a-buying-and-pro-state-execution.md`, starting at `9c2edd5`.

## Steps

- [x] 1. Server: at the device limit, the least recently seen device makes room
- [x] 2. `redeem` says what actually happened
- [x] 3. `syncEntitlement` — Pro matches Play on every launch and return
- [ ] 4. The app runs it on launch and on every return
- [ ] 5. Settings: Subscribe opens the Pro screen; Manage for everyone; fresh on focus
- [ ] 6. The Pro screen: purchase outcomes said honestly, and Restore
- [ ] 7. The record screen's trial button says the same
- [ ] 8. Lapsed: "Check again" and "Manage in Google Play"; the sentence stops over-claiming
- [ ] 9. The Library notices Pro the moment you come back
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

## Mutants

- M1: `server/app/store.py` `touch_device` — put `return False` back as the first line inside
  `if count >= DEVICE_LIMIT:`. All three named tests failed, plus the test_play.py one above (same
  rule, not anticipated by the sheet). Restored; full suite green (195 passed).
- M2: `src/billing/subscription.ts` `redeem` — changed `status >= 500` to `status > 999`. Exactly
  *a server or Google failure (5xx)…* failed (1 of 15). Restored; all 15 green.
- M3 did NOT kill its named test, code restored as-specified anyway (see Decisions).

## Notes for the next session
