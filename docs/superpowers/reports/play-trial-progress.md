# Play free trial + billing execution — progress

Tracking `docs/superpowers/specs/2026-09-23-play-trial-and-billing-execution.md`.

## Steps

- [x] 0. Land the release-prep changes already in the tree
- [x] 1. `OfferChoice` — which offer sells a base plan (pure, JVM-tested)
- [x] 2. `BillingModule` uses `OfferChoice`
- [x] 3. The in-app trial grants nothing in a release build
- [x] 4. Pro bought mid-recording lifts the cap on the recording already running
- [x] 5. Server: no grace on top of a cancelled subscription's token
- [x] 6. `PlayPlan` gains the trial; the pure trial helpers (Session B)
- [x] 7. Remove the in-app trial from `trial.ts` (Session B)
- [ ] 8. The paywall sells Play's trial (Session B)
- [ ] 9. The Summary tab offers Play's trial (Session B)
- [ ] 10. RecordScreen / OnboardingScreen (Session B)
- [ ] 11. Docs (Session B)
- [ ] 12. Gate / report (Session B)

## Decisions

- None yet.

## Mutants

- Step 1, M1: `OfferChoice.choose` return replaced with `mine.firstOrNull()` — killed by *a free
  trial is chosen…* and *a paid introductory offer is chosen…*. Restored.
- Step 1, M2: `OfferChoice.describe`'s `<` changed to `<=` — killed by *a trial plan is priced…*
  and *a plain base plan…*. Restored.
- Step 5, M3: `entitlement.py`'s new `grace` line hardcoded back to `PAYMENT_GRACE_SECONDS` —
  killed by *test_a_cancelled_subscription_mints_no_grace_past_its_end*. Restored.
- Step 6, M4: `trialLength`'s `factor *` changed to `1 *` — killed by *reads a week and seven
  days…*, *multiplies by the cycle count* (x2) and *never invents a period it cannot name*.
  Restored.

## Notes for the next session

- Session A (Steps 0–5) is native + server only, no device. Session B (Steps 6–12) is
  TypeScript/screens/docs/gate/report, no device. Session D is the founder's by-hand run.
- Session A complete (23 Sep 2026): all six steps (0–5) committed, `git status` clean, all
  three mutants (M1–M3) killed and restored. Kotlin unit tests and the full server pytest suite
  (195 passed) are green as of the last Step 5 commit.
- No deviations from the sheet through Step 6: every anchor, line range and exact code block
  matched what the sheet named, so nothing needed recording under *Decisions*.
- Step 6: `npx tsc --noEmit` was clean with no other `PlayPlan` literal needing the two new
  fields — no fixup needed.
- Step 7: after removing the in-app trial from `trial.ts`, `npx tsc --noEmit` names exactly the
  nine errors the sheet predicts, all in `PaywallScreen.tsx`, `SummaryTab.tsx`, `RecordScreen.tsx`,
  `OnboardingScreen.tsx` (Steps 8–10). `withNativeClock` and the `entitlement` import are now
  unused in `trial.test.ts`, but neither `tsc` nor `jest` flags them (no `noUnusedLocals`), so
  per the sheet's rule they were left in place, not deleted.
