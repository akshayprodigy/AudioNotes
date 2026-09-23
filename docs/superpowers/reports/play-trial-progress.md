# Play free trial + billing execution — progress

Tracking `docs/superpowers/specs/2026-09-23-play-trial-and-billing-execution.md`.

## Steps

- [x] 0. Land the release-prep changes already in the tree
- [ ] 1. `OfferChoice` — which offer sells a base plan (pure, JVM-tested)
- [ ] 2. `BillingModule` uses `OfferChoice`
- [ ] 3. The in-app trial grants nothing in a release build
- [ ] 4. Pro bought mid-recording lifts the cap on the recording already running
- [ ] 5. Server: no grace on top of a cancelled subscription's token
- [ ] 6. `PlayPlan` gains the trial; the pure trial helpers (Session B)
- [ ] 7. Remove the in-app trial from `trial.ts` (Session B)
- [ ] 8. The paywall sells Play's trial (Session B)
- [ ] 9. The Summary tab offers Play's trial (Session B)
- [ ] 10. RecordScreen / OnboardingScreen (Session B)
- [ ] 11. Docs (Session B)
- [ ] 12. Gate / report (Session B)

## Decisions

- None yet.

## Mutants

- None yet.

## Notes for the next session

- Session A (Steps 0–5) is native + server only, no device. Session B (Steps 6–12) is
  TypeScript/screens/docs/gate/report, no device. Session D is the founder's by-hand run.
