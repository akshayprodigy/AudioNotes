# Plan: a calm Plan & account page, "you're on Pro", and no-refund terms (release 1.1.6)

*Opus, 22 Oct 2026. Branch `plan-page-and-terms` off `95f58e5` (1.1.5). Built subagent-driven per
`CLAUDE.md`.*

**Founder, 22 Oct.** The Plan & account page is cluttered (the other Settings pages are fine).
Someone on Pro must see clearly that their current plan is Pro, and must not be offered Pro again.
Once bought, a period is bought: no refunds. The 7-day free trial is how people try the product.
Update the terms to match.

Facts: `Licence.status()` gives `{ plan: 'pro'|'free'|…, state: 'none'|'active'|'expired', paid,
expiresAt (unix s, 0 = none), account, lapsedCopy }`. A Play free trial is not distinguishable from a
paid period on the phone, so the page never says "trial"; it says "active through <date>".

---

## Task 1 — The Plan & account page (app)

Today (`src/screens/SettingsScreen.tsx`, the `section === 'plan'` block, ~lines 668–760): a
"SUBSCRIPTION" rule, a "Free allowance" card, then a "Pro"/"Free" card holding a paragraph, a "See
Pro plans" button, a row of "Restore purchase" + "Manage in Google Play", and "I already have an
account" (which expands an email/password form).

**Change.** Move this block into a new component `src/screens/settings/PlanSection.tsx` (props: what
it reads today — `lic`, `allowance`, `hasServer`, `playCan`, `playBusy`, `signedInAs`, the handlers
`onManage`, `onRestorePurchase`, `onSignOut`, `onSeePlans`, and the `emailSignIn` element), render
it from SettingsScreen in place of the block, and lay it out as:

- One card titled with an overline `CURRENT PLAN` and the plan name in large type: `Pro` or `Free`.
- **Pro** (`lic.paid`):
  - A line `Active through <d Month>` when `expiresAt > 0` (formatted like the allowance reset
    dates, e.g. "29 October"; reuse `formatReset` from `src/billing/allowanceCopy.ts` with a
    `YYYY-MM-DD` built from `expiresAt`), then `Renews in Google Play unless you cancel.`
    When `expiresAt` is 0: no date line, only `Everything in Pro is on.`
  - One `SoftButton` `Manage in Google Play` (only when `playCan`).
  - `Sign out` as a small text link, only when `signedInAs`.
  - NOTHING that sells or buys Pro: no allowance card, no "See Pro plans", no restore.
- **Free**:
  - The allowance as one line: the existing `settingsValue(allowance)` text (e.g. "5 of 5 left ·
    resets 1 November"), shown under the plan name. Drop the separate "Free allowance" card and the
    explainer line.
  - When `lic.state === 'expired'` and `lic.lapsedCopy`: show `lic.lapsedCopy` in one muted line.
  - One primary `Button` `See Pro plans` (when `playCan`) → `onSeePlans` (navigates to Paywall).
  - Under it, two small text links on one row: `Restore a purchase` (→ `onRestorePurchase`,
    disabled while `playBusy`) and `I already have an account` (→ expands the existing
    `emailSignIn` form below, with the existing one-line explanation). No "Manage in Google Play"
    on Free.
- Keep the existing no-server case (`!hasServer`): one muted line `This build has no licence server
  configured.` and nothing else interactive.
- Remove the `SUBSCRIPTION` SectionRule (the page title already says Plan & account).
- Small text links must be ≥ 44 dp tall touch targets (`minHeight: s(44)`, centred).

**Acceptance (tests in `src/screens/__tests__/SettingsScreen.allowance.test.tsx` or a new
`src/screens/settings/__tests__/PlanSection.test.tsx`):**
- Pro with `expiresAt` → renders `CURRENT PLAN`, `Pro`, `Active through …`, `Manage in Google
  Play`; renders none of `See Pro plans`, `Restore a purchase`, `I already have an account`,
  `Free allowance`, any `… left` allowance text.
- Free → `CURRENT PLAN`, `Free`, the allowance line, `See Pro plans` (pressing it calls
  `onSeePlans`), `Restore a purchase`, `I already have an account`; no `Manage in Google Play`.
- Expired with lapsedCopy → the lapsed line shows.
- Mutant: show `See Pro plans` regardless of `lic.paid` → the Pro test fails.
- Existing tests in `SettingsScreen.allowance.test.tsx` that asserted the old "Free allowance"
  card are updated to the new single line; list them.

## Task 2 — Say "no refunds" where the purchase is made (app)

`src/screens/PaywallScreen.tsx`, the pinned dock: under the existing terms line (`{terms ? … }`),
when not `bought`, add one muted line:
`Payments aren't refundable — the free week is for trying it.` when the chosen plan has a trial
(`chosenFree`), otherwise `Payments aren't refundable.`

**Acceptance:** PaywallScreen tests — with a trial plan the first sentence shows; with a no-trial
plan the second shows; once bought, neither shows. Mutant: drop the `!bought` guard → the bought
test fails. The existing "buy button and terms are pinned outside the scroll" test must still pass
(the new line is in the dock).

## Task 3 — Terms: purchases are final (server)

`server/app/legal.py` `_terms()` and `server/app/branding.py` `LEGAL_UPDATED`.

**Change.**
1. "The subscription" list, first bullet → `Bought in the app through Google Play, monthly or
   yearly, and renewed automatically until cancelled.` Add a bullet: `New subscribers can try it
   free for 7 days. Cancel in Google Play before the trial ends and you are not charged.`
2. Replace the whole "Refunds" section body with:
   `Payments are final. We do not refund a period once it has been charged — the free trial is the
   way to try ${PRODUCT_NAME} before paying. Cancelling stops the next renewal; you keep everything
   you have paid for until the end of that period. This does not take away a refund Google Play
   gives under its own refund policy, or any right you have under the consumer law where you live.`
3. `LEGAL_UPDATED = "22 October 2026"`.
4. "Ending things" keeps its sentence about refunding an unused period when WE end an account.

**Acceptance:** a server test (in `server/tests/`, follow the existing style; run with the repo's
server test command, e.g. `cd server && python -m pytest -q`) that GET `/terms` contains
`Payments are final`, `monthly or yearly`, `free for 7 days`, `22 October 2026`, and does NOT
contain `within 7 days of a charge`. Mutant: restore the old Refunds text → the test fails.
**Do not deploy.** Deployment to the live server is the controller's call after the founder sees
the wording.

---

## After all tasks (Opus)
Whole-branch review (Sonnet), gate re-run, an emulator look at the Plan page (Free) via a Sonnet
checker, merge, 1.1.6, full gate, AAB. Server deploy only after the founder approves the terms text.
