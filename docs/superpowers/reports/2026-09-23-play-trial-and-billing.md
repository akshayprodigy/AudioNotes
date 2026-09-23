# Play free trial + billing — built, gate clear, by-hand steps for the founder

Tracking `docs/superpowers/specs/2026-09-23-play-trial-and-billing-execution.md`. Sessions A
(Steps 0–5) and B (Steps 6–12) both complete.

## 1. Status

Built and gate-clear (all seven mutants killed and restored, full jest/tsc/pytest/Kotlin green,
release build compiles under R8); the Play billing purchase flow itself was not run — it needs
the founder's Play Console product, service account and a licence tester (§7 below).

## 2. What was built, per step

- **Step 0** — land the release-prep changes (R8, resource shrinking, Billing Library 8.3.0,
  version 1.0.1) and fix the `docs/play-console.md` typo: `2e6c29d`. Progress file created:
  `a39e6fc`.
- **Step 1** — `OfferChoice`, pure/JVM-tested, picks which Play offer sells a base plan:
  `e15551c` (mutants M1, M2). Progress: `9ef2724`.
- **Step 2** — `BillingModule.plans()`/`purchase()` use `OfferChoice`, one paywall row per base
  plan: `bc0264c`.
- **Step 3** — the in-app trial grants nothing outside a debug build: `f6bd3b3`.
- **Step 4** — a purchase during the cap warning lifts the cap on the recording already running:
  `81f9141`. Progress (Steps 2–3): `b2a45a6`.
- **Step 5** — server: no payment grace on top of a cancelled subscription's token: `30c6fcf`
  (mutant M3). Progress (Session A complete): `d61e3bd`.
- *(Between sessions, not part of this sheet's steps: `7f4b235` points `gradle.properties` at the
  founder's live Play product id, `verbale_pro_1m`.)*
- **Step 6** — `PlayPlan` gains `trialPeriod`/`trialCycles`; `src/billing/trialTerms.ts`
  (`trialLength`, `trialTerms`, `trialPlan`): `838270c` (mutant M4).
- **Step 7** — the in-app trial leaves `trial.ts`; `entitlement()` is just the licence: `c9fe5d4`.
  Progress (Steps 6–7): `7eef81b`.
- **Step 8** — the paywall sells Play's trial with its terms, drops the old trial button:
  `9880b31` (mutants M5, M6).
- **Step 9** — the Summary tab's locked card offers Play's trial when this account can have one:
  `3ae5c36` (mutant M7). Progress (Steps 8–9): `a854666`.
- **Step 10** — RecordScreen's cap card and OnboardingScreen's first-run choice both route through
  Play (`buyWithPlay` / `navigation.navigate('Paywall', { from: 'onboarding' })`): `0708fba`.
  Progress (Step 10): `51e1d67`.
- **Step 11** — `docs/play-console.md`: the real product/base-plan/offer ids, the inline
  service-account key procedure, "the free trial is Play's": `2fbbd1b`.
- **Step 12** — gate, release build, this report (below).

## 3. Decisions

- **Step 6**: `npx tsc --noEmit` was clean with no other `PlayPlan` object literal needing the two
  new fields — no fixup needed anywhere else in the tree.
- **Step 7**: after removing the in-app trial from `trial.ts`, `npx tsc --noEmit` named exactly
  the nine errors the sheet predicted, all in `PaywallScreen.tsx`, `SummaryTab.tsx`,
  `RecordScreen.tsx`, `OnboardingScreen.tsx` (left for Steps 8–10). `withNativeClock` and the
  `entitlement` import became unused in `trial.test.ts`, but neither `tsc` nor `jest` flags unused
  locals in this project (no `noUnusedLocals`), so per the sheet's own rule ("delete them only if
  tsc or jest says so") they were left in place, not deleted.
- **Step 8**: `PaywallScreen.tsx`'s style object already had inconsistent indentation around
  `secondary`/`note`/`signIn` before this sheet touched it. Only the now-unused `secondary` line
  was removed; the pre-existing indentation of its neighbours was left exactly as found.
- **Step 12.1**: running `scripts/gate.sh` as instructed triggered its `device` stage, which found
  one authorized Android device attached and ran the existing native instrumented suite
  (`NativePipelineTest`, `MinutesParityTest`, `ItemsDbTest`, and twelve more — none of them related
  to this sheet's billing/trial work) against it via `npm run test:device` →
  `scripts/device-verify.sh`. That script is deliberately not `connectedDebugAndroidTest` — its
  own header explains it avoids that command specifically because it uninstalls the app and wipes
  the phone's models and database — and instead uses `adb install -r` (keeps app data) plus
  `am instrument`. All sixteen device test classes passed and nothing was uninstalled or wiped.
  This nonetheless used `adb`, which contradicts this sheet's explicit "Never run `adb` in
  Sessions A or B" rule; it was surfaced to the founder mid-session, who chose to continue rather
  than stop. No file touched by this session was affected — the device stage only exercises the
  pre-existing native core.

## 4. Tests

| Test | Result | Mutant | Mutant result |
|---|---|---|---|
| `OfferChoiceTest` (8 tests) | `BUILD SUCCESSFUL`, `tests="8" failures="0"` | M1: `choose`'s return replaced with `mine.firstOrNull()` | killed by *a free trial is chosen…* and *a paid introductory offer is chosen…*; restored |
| — | — | M2: `describe`'s `<` changed to `<=` | killed by *a trial plan is priced…* and *a plain base plan…*; restored |
| Server pytest, full suite | `passed`, 0 failed | M3: `grace` hardcoded back to `PAYMENT_GRACE_SECONDS` | killed by `test_a_cancelled_subscription_mints_no_grace_past_its_end`; restored |
| `trialTerms.test.ts` (10 tests) | 10/10 passed | M4: `factor *` changed to `1 *` | killed by 4 tests incl. *reads a week and seven days…*; restored |
| `PaywallScreen.test.tsx` (5 tests) | 5/5 passed | M5: `priceLabel`'s `chosenFree ?` arm deleted | killed by 3 tests incl. *offers the trial on the preselected plan…*; restored |
| — | — | M6: the `from === 'onboarding'` early-return in `onBuy` deleted | killed by *from first run, a purchase goes straight back to setup*; restored |
| `src/screens/meeting` suite (24 tests) | 24/24 passed | M7: `SummaryTab`'s CTA label hardcoded to `'Get Pro'` | killed by *offers the trial when Play has one for this account*; restored |
| `npx jest src/billing --silent` | 5 suites, 54 tests passed | — | — |
| Full `npx jest --silent` | 65 suites, 617 tests passed | — | — |
| `npx tsc --noEmit` | clean, no output | — | — |
| Kotlin, `:app:testDebugUnitTest --rerun-tasks` | `BUILD SUCCESSFUL` | — | — |

A post-teardown `ReferenceError` (`PixelRatio` access after Jest's environment tore down) prints
after the full-suite summary, attributed to `MeetingScreen.test.tsx`. It does not fail any test or
suite (65/65, 617/617 both passed) and is a pre-existing leak in a file this session never
touched — not a regression from Steps 6–10.

`git grep -n -E "TRIAL_DAYS|TRIAL_SUMMARIES|startTrial|noteTrialSummary|trialState" -- src` and
`git grep -n "No card, nothing to cancel|no account, no card" -- src` both return nothing.

## 5. Gate summary

| Stage | Result |
|---|---|
| types | ok (3s) |
| js | ok (7s) |
| scans | ok (2s) |
| mutations | ok (76s) |
| kotlin | ok (3s) |
| cpp | ok (24s) |
| device | ok (61s) — ran against a connected/authorized device; see Decisions §12.1 |

`gate: all clear in 176s`.

`cd android && ./gradlew :app:assembleRelease` → `BUILD SUCCESSFUL` (R8 minify ran; only benign
pre-existing `play-services-auth` stack-map warnings, no `Missing class` or keep-rule error). APK
was not installed.

## 6. Device

The by-hand Play billing verification below (§7) was **not run** — it needs the founder's Play
Console product, a Google Cloud service account wired into the server, and a licence tester
signed into a build from a Play testing track, none of which a builder session has.

Separately, and unrelated to Play billing: the gate's own `device` stage (§5 above) did run,
against whichever Android device was attached and authorized when Step 12.1 executed — the
pre-existing native core instrumented suite, not this sheet's changes. See Decisions.

## 7. By hand, for the founder

1. Probe: `curl -s -X POST https://verbale.innocorelabs.com/api/billing/play/link -H 'content-type: application/json' -d '{"purchaseToken":"probe","deviceId":"probe"}'` — must NOT say "not configured".
2. Install the release build from the **internal testing** track, signed in as a licence tester
   who has never subscribed. Open Pro. Expect two rows: **Monthly ₹299 · 7 days free** and
   **Yearly ₹2,499 · 7 days free** with ~~₹3,588~~ save 30%; Yearly preselected; button
   **Try it free for 7 days**; under it *Free for 7 days, then ₹2,499 a year until you cancel.
   Cancel in Google Play before the trial ends and you pay nothing.*
3. Tap it. Play's sheet must say the trial and the price after it. Confirm. Expect the alert
   **Your free trial has started**, then the writer download with its byte counter. Settings
   shows Pro. (Test trials last minutes: Play then renews it as a test charge.)
4. Reopen Pro: headline *You are on Pro*. In Play → Subscriptions, Verbale shows the trial.
5. **Cap lift** (a second, never-subscribed tester, or the first after its test subscription
   has lapsed): record past 12:00 → the card reads *…Pro has no limit. Free for 7 days, then
   ₹299 a month…* with **Keep recording — 7 days free**. Tap, buy. The recording must run
   **past 15:00** and keep going. `adb logcat -d | grep "cap lifted" | tail -2` shows the line.
6. **First run**: `pm clear` → onboarding shows **Try Pro free for 7 days** (an account that
   has had a trial sees **Get Pro** — correct). Tap → Pro screen → buy → it returns to setup
   by itself, now as Pro, and the Download button includes the writer.
7. **Summary card** on an unpaid account with a trial left: **Try it free for 7 days**; with
   none left: **Get Pro**.
8. Cancel the test subscription in Play. After the next licence refresh Pro ends at the
   trial's end with no extra three days.

## 8. Known gaps

- Onboarding and Record screens have no jest harness — proof is §7 steps 5–6.
- The in-app trial's native half, `Trial.kt`, remains as a debug-only entitlement lever for the
  device tests; a release build never reads it.
- The by-hand Play billing verification (§7) has not been run by any builder session — see §6.

## 9. Commits

```
2fbbd1b docs(play-console): one subscription, Play's free trial, and the service account that works
51e1d67 docs: progress — Step 10 done
0708fba feat(record,onboarding): Play's trial from the cap card and from first run
a854666 docs: progress — Steps 8 and 9 done
3ae5c36 feat(summary): the locked card offers Play's trial when this account can have one
9880b31 feat(paywall): sell Play's free trial with its terms; the in-app trial button goes
7eef81b docs: progress — Steps 6 and 7 done
c9fe5d4 refactor(billing): entitlement is the licence; the in-app trial leaves trial.ts
838270c feat(billing): PlayPlan carries Play's free trial; trialTerms says it in words
7f4b235 build(billing): point at the live Play product, verbale_pro_1m (both base plans)
d61e3bd docs: progress — Session A (Steps 0-5) complete
30c6fcf fix(server): a cancelled subscription's licence ends with its period, no grace on top
81f9141 fix(record): a purchase during the cap warning lifts the cap on the running recording
b2a45a6 docs: progress — Steps 2 and 3 done
f6bd3b3 fix(billing): the in-app trial is a debug-only test lever, not a release entitlement
bc0264c fix(billing): one paywall row per base plan, and buy its free trial when eligible
9ef2724 docs: progress — Step 1 (OfferChoice) done, mutants M1/M2 recorded
e15551c feat(billing): OfferChoice — sell a base plan with its free trial, one row per plan
a39e6fc docs: create the Play trial + billing execution progress file
2e6c29d build(release): R8 + resource shrinking, Play Billing 8.3.0, version 1.0.1
```
