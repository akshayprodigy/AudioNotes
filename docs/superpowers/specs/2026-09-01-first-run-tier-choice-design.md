# First-run tier choice, sign-in, and the Pro nudge — design

**Date:** 2026-09-01
**Status:** Approved (design)
**Platform:** Android (JS/UI only — no native mirror needed)
**Related code:** `src/screens/OnboardingScreen.tsx`, `src/screens/PaywallScreen.tsx`,
`src/screens/LibraryScreen.tsx`, `src/screens/SettingsScreen.tsx`, `src/billing/trial.ts`,
`src/billing/subscription.ts`

## Overview

A new install goes straight from an intro to a 114 MB download, and never mentions that a paid
tier exists until a full-screen sell arrives after the first meeting finishes. That screen
surprised the founder on his own device, which is a fair proxy for how a new user meets it.

At the same time, someone who has already paid — on the website, or on a previous phone — has no
way to say so from the one screen that talks about Pro. Sign-in exists only inside Settings.

This design makes the free/Pro choice visible during setup, keeps the later sell for people who
chose free, adds a bounded recurring nudge, and puts sign-in where it is needed.

## Goals

- A new user **sees** that free and Pro exist, and chooses, during setup.
- Choosing free needs **no account, no email**. The app records within seconds of install.
- Someone who already subscribed can sign in from the screen that offers Pro.
- Free users are reminded about Pro periodically, and that reminder **stops** if they keep saying no.

## Non-goals

- No mandatory login. See "Rejected" below.
- No cross-device sync, no accounts for free users, no server-side user model changes.
- No change to what Pro *is*. The paid half stays: prose summaries, narrated minutes, whisper-small.

## Constraint that shapes everything

Choosing Pro adds **1.2 GB** to the first-run download (Qwen 1,117 MB + whisper-small 190 MB). So
the choice must be made **at or before** the download step. Asking afterwards means a second large
download, which is why the tier step goes where it does and not somewhere more comfortable.

## Design

### 1. Tier step in onboarding

A new step between the intro and the download, replacing the bare "Download the AI (114 MB)"
button.

| Choice | Effect |
|---|---|
| **Free** | Downloads the 114 MB required set. Straight to "All set". No account. |
| **Pro** | Starts the 7-day trial, then downloads 1.3 GB (required set + whisper-small + Qwen). |
| **Already subscribed? Sign in** | Opens the existing email/password form; on success, behaves as Pro. |

Choosing Pro starts the **trial**, not a purchase. A card before the app has transcribed anything
is the weakest possible ask, and the trial is the only honest answer to "is it any good on MY
meetings" — which is the only question that matters for this product. Buying outright stays
available on the Pro screen and in Settings.

This replaces the existing `wantWriter` switch in `OnboardingScreen`, which is present today but
hidden unless the user already pays — so it can never be the thing that *sells* Pro.

### 2. The post-first-meeting Pro screen stays, for free users only

`shouldOfferPaywall` already returns true only when the paywall has never been seen, the user is
not paid, and the trial is `unstarted`. That is already flow B's rule and needs no logic change.

The one hazard: the onboarding tier step must **not** call `markPaywallSeen()`. If it did, someone
who chose free at setup would never get the sell at the strong moment — after they have seen the
app work on their own meeting. Declining at setup and declining after a real meeting are different
refusals, and only the second one has any information in it.

### 3. The recurring nudge

A dismissible card above the meeting list in `LibraryScreen`.

**Shown when all of:**
- at least `NUDGE_EVERY` (5) meetings have finished since the card was last shown
- not entitled — neither a paid subscription nor a trial currently running
- refusals so far `< NUDGE_MAX_REFUSALS` (3)

**Behaviour:**
- Tapping it opens the existing `PaywallScreen`.
- "Not now" increments the refusal count and records the current meeting count.
- After the third refusal it never appears again. Someone who has said no three times is not a
  customer being lost by silence — they are one being kept by it.

Deliberately a card and not a full-screen takeover. A takeover arriving the moment a meeting
finishes lands exactly when the user came to read something, and that is the pattern behind the
"it keeps nagging me" reviews that this product is positioned against.

### 4. Sign-in on the Pro screen

`PaywallScreen` gains "Already subscribed? Sign in", using the same email/password form as
Settings. This is a defect fix, not a feature: today the only screen that explains Pro offers no
way for an existing subscriber to get it onto the phone.

## State

Two new settings, both in the existing settings table, both JS-only:

| Key | Meaning |
|---|---|
| `pro_nudge_refusals` | How many times "Not now" has been tapped. Stops at `NUDGE_MAX_REFUSALS`. |
| `pro_nudge_last_count` | Completed-meeting count when the nudge was last shown. |

No Kotlin mirror. Unlike the trial state and the minute item hash — both of which are enforced
natively because a gate in the JS bundle is a gate anyone can edit — this is presentation only.
Nothing here decides entitlement; `Narrator` and `ModelCatalog.needsSubscription` still do, in
Kotlin, and remain the enforcement.

## Edge cases

- **Play Billing unavailable** (which is the state today — the subscription product does not exist
  yet): the Pro option must degrade to "Start the free trial" and "Sign in". Never a dead button
  and never a blank price. This also means the whole flow is testable before the price is decided.
- **Trial already used** (started and ended): the onboarding Pro option offers purchase and
  sign-in, not another trial. `trial.ts` already tracks `trial_ended_at`.
- **Download declined or failed on Pro**: a failed 1.1 GB writer-model download must not fail
  setup. Existing behaviour already treats a non-required model's failure as survivable; the trial
  stays started and the model is fetchable later from Settings.
- **Sign-in succeeds mid-onboarding**: the download queue must be recomputed to include the Pro
  models before the download starts.
- **Meeting count** means meetings that reached `READY`. Archived meetings still count; deleting
  meetings can lower the count, which is harmless — the nudge simply waits for the next threshold.

## Testing

The nudge decision is extracted as a pure function alongside `shouldOfferPaywall` in
`src/billing/trial.ts`:

```
shouldNudgeForPro({ completed, lastShownAt, refusals, entitlement }) -> boolean
```

Unit-testable with no screen and no database. Cases to pin:

- fires at 5, 10, 15; does not fire at 4, 6, or twice for the same threshold
- never for a subscriber, never during an active trial
- stops permanently after the third refusal
- a lowered count (meetings deleted) does not re-fire an already-shown threshold

Existing suites that must stay green: `trial.test.ts`, `library.test.ts`, and the Kotlin
`TrialTest` (unchanged, but it mirrors the trial state this feature now starts earlier).

## Rejected

**Mandatory login for everyone.** It contradicts the landing page — *"Free, forever … No account
needed. Nothing expires."* — and it contradicts the privacy pitch: an app whose promise is that
nothing leaves your phone should not demand an email before it will record. It is also the single
most reliable place to lose installs. The problem it was reaching for was discoverability, and
discoverability is solved by items 1 and 4 without a gate.

**A full-screen nudge every 5 meetings.** Considered and rejected as the default because it
interrupts at the exact moment the user opened the app to read notes. If conversion data later
argues for it, the trigger and the surface are separate in the code and the surface can change
without touching the rule.
