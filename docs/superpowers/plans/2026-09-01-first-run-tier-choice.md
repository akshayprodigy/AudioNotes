# First-run tier choice, sign-in, and the Pro nudge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the free/Pro choice visible during setup without a login wall, put sign-in on the screen that explains Pro, and add a recurring nudge that stops asking after three refusals.

**Architecture:** All changes are JS/TS. The decision rules go in `src/billing/trial.ts` as pure functions beside the existing `shouldOfferPaywall`, so they are unit-testable with no screen and no database. Persistence uses the existing settings table via `db.getSetting`/`db.setSetting`. The email/password form is extracted from `SettingsScreen` into a shared component so the paywall and settings cannot drift. No Kotlin mirror: entitlement is still enforced natively by `Narrator` and `ModelCatalog.needsSubscription`, and nothing added here decides entitlement.

**Tech Stack:** React Native 0.86, TypeScript, Jest, Zustand (`libraryStore`), existing `ui.tsx` primitives (`Button`, `SoftButton`, `Txt`, `Raised`).

**Spec:** `docs/superpowers/specs/2026-09-01-first-run-tier-choice-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/billing/trial.ts` (modify) | Add nudge constants, the pure `shouldNudgeForPro`, and the two persistence helpers. Sits with `shouldOfferPaywall` because it is the same kind of rule. |
| `src/billing/__tests__/trial.test.ts` (modify) | Tests for both. |
| `src/billing/SignInForm.tsx` (create) | The email/password form, extracted so paywall and settings share one implementation. |
| `src/screens/PaywallScreen.tsx` (modify) | "Already subscribed? Sign in". |
| `src/screens/SettingsScreen.tsx` (modify) | Use the extracted form. |
| `src/screens/ProNudgeCard.tsx` (create) | The dismissible library card. Its own file so `LibraryScreen` does not grow another responsibility. |
| `src/screens/LibraryScreen.tsx` (modify) | Decide whether to show the card, and render it. |
| `src/screens/OnboardingScreen.tsx` (modify) | The tier step. |

---

### Task 1: The nudge rule (pure function)

**Files:**
- Modify: `src/billing/trial.ts`
- Modify: `src/billing/__tests__/trial.test.ts`
- Modify: `docs/superpowers/specs/2026-09-01-first-run-tier-choice-design.md`

- [ ] **Step 1: Write the failing tests**

Append to `src/billing/__tests__/trial.test.ts`. Add `NUDGE_EVERY`, `NUDGE_MAX_REFUSALS` and `shouldNudgeForPro` to the existing `import { ... } from '../trial';` block at the top of the file.

```ts
describe('shouldNudgeForPro', () => {
  const free = { paid: false };
  const paid = { paid: true };

  it('waits until enough meetings have been finished', () => {
    expect(shouldNudgeForPro({ completed: 4, lastShownAt: 0, refusals: 0, entitlement: free })).toBe(false);
    expect(shouldNudgeForPro({ completed: 5, lastShownAt: 0, refusals: 0, entitlement: free })).toBe(true);
  });

  it('waits another full interval after each showing', () => {
    expect(shouldNudgeForPro({ completed: 6, lastShownAt: 5, refusals: 1, entitlement: free })).toBe(false);
    expect(shouldNudgeForPro({ completed: 10, lastShownAt: 5, refusals: 1, entitlement: free })).toBe(true);
  });

  it('survives a jump that skips the exact multiple', () => {
    // Importing several files at once moves the count 4 -> 7. A "multiple of 5" rule would never
    // fire again; this one does.
    expect(shouldNudgeForPro({ completed: 7, lastShownAt: 0, refusals: 0, entitlement: free })).toBe(true);
  });

  it('does not re-fire when meetings are deleted and remade', () => {
    // Shown at 10, user deletes down to 6. Nothing new has happened, so nothing is offered.
    expect(shouldNudgeForPro({ completed: 6, lastShownAt: 10, refusals: 1, entitlement: free })).toBe(false);
  });

  it('never offers to someone who is entitled', () => {
    // `paid` is true for a subscriber AND for a running trial — see entitlement().
    expect(shouldNudgeForPro({ completed: 50, lastShownAt: 0, refusals: 0, entitlement: paid })).toBe(false);
  });

  it('stops for good after the third refusal', () => {
    expect(shouldNudgeForPro({ completed: 100, lastShownAt: 0, refusals: NUDGE_MAX_REFUSALS, entitlement: free })).toBe(false);
    expect(shouldNudgeForPro({ completed: 100, lastShownAt: 0, refusals: NUDGE_MAX_REFUSALS - 1, entitlement: free })).toBe(true);
  });

  it('the interval is the one the card copy promises', () => {
    expect(NUDGE_EVERY).toBe(5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- trial`
Expected: FAIL — `shouldNudgeForPro is not a function` (and TS errors on the new imports).

- [ ] **Step 3: Implement**

Add to `src/billing/trial.ts`, immediately after `markPaywallSeen`:

```ts
/**
 * How often the library offers Pro to a free user, counted in finished meetings.
 *
 * Deliberately expressed as "another N since we last asked" rather than "every Nth meeting". A
 * user who imports four files at once moves the count 4 -> 7 and a multiple-of-N rule would step
 * straight over the threshold and never fire again. This form also copes with deletion: the count
 * can fall, and nothing is offered again until it has genuinely grown.
 */
export const NUDGE_EVERY = 5;

/**
 * After this many refusals the app stops asking, permanently.
 *
 * Somebody who has said no three times is not a customer being lost by silence — they are one
 * being kept by it. This product's whole pitch is that it does not behave like the incumbents,
 * and "it keeps nagging me" is the most common complaint levelled at them.
 */
export const NUDGE_MAX_REFUSALS = 3;

export interface NudgeInput {
  /** Meetings that reached 'done'. */
  completed: number;
  /** `completed` at the moment the card was last shown; 0 if it never has been. */
  lastShownAt: number;
  refusals: number;
  /** Only `paid` is read: it is already true for a subscriber OR a running trial. */
  entitlement: Pick<Entitlement, 'paid'>;
}

/** Whether the library should offer Pro right now. Pure: no clock, no database. */
export function shouldNudgeForPro(i: NudgeInput): boolean {
  if (i.entitlement.paid) return false;
  if (i.refusals >= NUDGE_MAX_REFUSALS) return false;
  return i.completed >= i.lastShownAt + NUDGE_EVERY;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- trial`
Expected: PASS, all cases green.

- [ ] **Step 5: Correct the spec so it matches**

In `docs/superpowers/specs/2026-09-01-first-run-tier-choice-design.md`, replace these two bullets:

```
- completed meeting count is a positive multiple of `NUDGE_EVERY` (5)
- the count has grown since it was last shown (so it appears once per threshold, not on every render)
```

with:

```
- at least `NUDGE_EVERY` (5) meetings have finished since the card was last shown
```

- [ ] **Step 6: Commit**

```bash
git add src/billing/trial.ts src/billing/__tests__/trial.test.ts docs/superpowers/specs/2026-09-01-first-run-tier-choice-design.md
git commit -m "feat(billing): the rule for when to offer Pro again"
```

---

### Task 2: Remembering the nudge

**Files:**
- Modify: `src/billing/trial.ts`
- Modify: `src/billing/__tests__/trial.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/billing/__tests__/trial.test.ts`. Add `nudgeState`, `noteNudgeShown` and `refuseNudge` to the import block.

```ts
describe('nudge persistence', () => {
  it('starts at zero on a fresh install', async () => {
    expect(await nudgeState()).toEqual({ refusals: 0, lastShownAt: 0 });
  });

  it('remembers the count it was last shown at', async () => {
    await noteNudgeShown(5);
    expect(await nudgeState()).toEqual({ refusals: 0, lastShownAt: 5 });
  });

  it('counts refusals up to the cap', async () => {
    await refuseNudge();
    await refuseNudge();
    expect((await nudgeState()).refusals).toBe(2);
  });

  it('refusing does not disturb the count it was shown at', async () => {
    await noteNudgeShown(10);
    await refuseNudge();
    expect(await nudgeState()).toEqual({ refusals: 1, lastShownAt: 10 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- trial`
Expected: FAIL — `nudgeState is not a function`.

- [ ] **Step 3: Implement**

Add the keys beside the other `const KEY_*` declarations in `src/billing/trial.ts`:

```ts
const KEY_NUDGE_REFUSALS = 'pro_nudge_refusals';
const KEY_NUDGE_LAST_COUNT = 'pro_nudge_last_count';
```

And after `shouldNudgeForPro`:

```ts
export interface NudgeState {
  refusals: number;
  lastShownAt: number;
}

/**
 * Both halves of the nudge's memory. Read together so a render never sees one without the other.
 *
 * Every read is guarded: a settings row that cannot be read must degrade to "never shown, never
 * refused", which at worst offers Pro once more than intended. The opposite default would silence
 * the feature permanently on a transient error, and nothing would ever report it.
 */
export async function nudgeState(): Promise<NudgeState> {
  const [refusals, lastShownAt] = await Promise.all([
    db.getSetting(KEY_NUDGE_REFUSALS).catch(() => null),
    db.getSetting(KEY_NUDGE_LAST_COUNT).catch(() => null),
  ]);
  return { refusals: int(refusals), lastShownAt: int(lastShownAt) };
}

/** Called when the card is actually rendered, not when it becomes eligible. */
export async function noteNudgeShown(completed: number): Promise<void> {
  await db.setSetting(KEY_NUDGE_LAST_COUNT, String(completed)).catch(() => {});
}

/** "Not now". Counts towards NUDGE_MAX_REFUSALS, after which the card never returns. */
export async function refuseNudge(): Promise<void> {
  const { refusals } = await nudgeState();
  await db.setSetting(KEY_NUDGE_REFUSALS, String(refusals + 1)).catch(() => {});
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- trial`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/billing/trial.ts src/billing/__tests__/trial.test.ts
git commit -m "feat(billing): remember when Pro was offered and how often it was declined"
```

---

### Task 3: One sign-in form, shared

**Files:**
- Create: `src/billing/SignInForm.tsx`
- Modify: `src/screens/SettingsScreen.tsx`

There are no unit tests in this task: it is a pure extraction with no new behaviour, and the behaviour it moves is already covered by `playPurchase.test.ts`. The verification is that Settings still signs in, checked in Task 6's manual pass.

- [ ] **Step 1: Create the shared form**

Create `src/billing/SignInForm.tsx`:

```tsx
/**
 * The email/password form, in one place.
 *
 * It is needed on two screens for different reasons — in Settings because that is where an account
 * is managed, and on the paywall because that is the only screen that explains Pro, and somebody
 * who already bought it on the website had no way to say so. Two copies of a login form is two
 * places for a validation rule or an error message to drift.
 */
import React, { useState } from 'react';
import { Alert, TextInput, View } from 'react-native';

import { SoftButton } from '../components/ui';
import { useTheme } from '../theme';
import { signIn } from './subscription';

export default function SignInForm({ onSignedIn }: { onSignedIn?: () => void }) {
  const { colors } = useTheme();
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await signIn(email.trim(), pass);
      // Signing in successfully but on a free account is not an error, and saying "signed in"
      // and changing nothing would leave the user hunting for what went wrong.
      Alert.alert(
        res.paid ? 'Signed in' : 'Signed in — no subscription on this account',
        res.paid
          ? 'Pro is on for this device.'
          : 'The account is fine, it just has no active subscription.',
      );
      if (res.paid) onSignedIn?.();
    } catch (e: any) {
      Alert.alert('Could not sign in', String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const field = {
    borderWidth: 1,
    borderColor: colors.line,
    color: colors.ink,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginTop: 8,
  } as const;

  return (
    <View>
      <TextInput
        style={field}
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        placeholderTextColor={colors.inkFaint}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <TextInput
        style={field}
        value={pass}
        onChangeText={setPass}
        placeholder="Password"
        placeholderTextColor={colors.inkFaint}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      <SoftButton
        icon="lock"
        label={busy ? 'Signing in…' : 'Sign in'}
        onPress={submit}
        disabled={busy || !email || !pass}
      />
    </View>
  );
}
```

- [ ] **Step 2: Use it in Settings**

In `src/screens/SettingsScreen.tsx`, add the import:

```tsx
import SignInForm from '../billing/SignInForm';
```

Replace the whole `const emailSignIn = ( ... );` block (the JSX fragment holding two `TextInput`s and the `Sign in` `SoftButton`) with:

```tsx
  // One form, two places: here, and on the paywall behind "Already subscribed?".
  const emailSignIn = <SignInForm onSignedIn={refreshLicence} />;
```

Then delete the now-unused `licEmail`, `licPass`, `licBusy` state declarations and the `onSignIn` callback from `SettingsScreen`. Keep `refreshLicence` — if the screen's licence refresher has a different name, pass that instead; it is the function already called after `restorePlayPurchase` succeeds.

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit`
Expected: exit 0, no unused-variable or missing-symbol errors.

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 4: Commit**

```bash
git add src/billing/SignInForm.tsx src/screens/SettingsScreen.tsx
git commit -m "refactor(billing): one sign-in form, so two screens cannot drift"
```

---

### Task 4: Sign-in on the Pro screen

**Files:**
- Modify: `src/screens/PaywallScreen.tsx`

This is the defect fix and is worth shipping on its own.

- [ ] **Step 1: Add the form behind a disclosure**

In `src/screens/PaywallScreen.tsx`, add to the imports:

```tsx
import SignInForm from '../billing/SignInForm';
```

Add state beside the existing `const [busy, setBusy] = useState<'trial' | 'buy' | null>(null);`:

```tsx
  // Collapsed by default: this screen is for people deciding, and a login form at the top of it
  // reads as a wall. It only needs to be findable by the minority who already paid.
  const [showSignIn, setShowSignIn] = useState(false);
```

- [ ] **Step 2: Render it under the buy/trial buttons**

Immediately after the block containing the trial and price buttons, and before the `FREE_FOREVER` copy, insert:

```tsx
          {!ent?.licence?.paid && (
            <View style={{ marginTop: 18 }}>
              {showSignIn ? (
                <SignInForm onSignedIn={() => navigation.goBack()} />
              ) : (
                <SoftButton
                  icon="lock"
                  label="Already subscribed? Sign in"
                  onPress={() => setShowSignIn(true)}
                />
              )}
            </View>
          )}
```

If `SoftButton` and `View` are not already imported in this file, add them: `View` from `react-native`, `SoftButton` from `../components/ui`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: exit 0.

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 4: Commit**

```bash
git add src/screens/PaywallScreen.tsx
git commit -m "fix(billing): let an existing subscriber sign in from the screen that sells Pro"
```

---

### Task 5: The nudge card in the library

**Files:**
- Create: `src/screens/ProNudgeCard.tsx`
- Modify: `src/screens/LibraryScreen.tsx`

- [ ] **Step 1: Create the card**

Create `src/screens/ProNudgeCard.tsx`:

```tsx
/**
 * The recurring offer of Pro, as a card above the meeting list.
 *
 * Deliberately not a full-screen takeover. A takeover arriving the moment a meeting finishes lands
 * exactly when the user opened the app to read something, and "it keeps nagging me" is the
 * complaint this product is positioned against. A card is visible every time they open the
 * library and blocks nothing.
 *
 * Whether it appears at all is decided by shouldNudgeForPro; this file only draws it.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Raised, SoftButton, Txt } from '../components/ui';
import { s, useTheme, type Colors } from '../theme';

export default function ProNudgeCard({
  meetings,
  onOpen,
  onDismiss,
}: {
  meetings: number;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);

  return (
    <Raised style={st.card}>
      <Txt variant="cardTitle" style={st.title}>
        Your last {meetings} meetings, written up
      </Txt>
      <Txt variant="meta" color={colors.inkDim} style={st.body}>
        Pro reads the whole transcript and writes the minutes in sentences you can send to someone
        who was not there. Seven days free, on your own meetings.
      </Txt>
      <View style={st.row}>
        <View style={st.grow}>
          <Button label="See what it does" icon="ai" onPress={onOpen} full />
        </View>
        <SoftButton label="Not now" onPress={onDismiss} />
      </View>
    </Raised>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    card: { padding: s(16), marginBottom: s(14), backgroundColor: c.card },
    title: { marginBottom: s(6) },
    body: { marginBottom: s(12) },
    row: { flexDirection: 'row', gap: s(10), alignItems: 'center' },
    grow: { flex: 1 },
  });
}
```

- [ ] **Step 2: Decide and render it in the library**

In `src/screens/LibraryScreen.tsx`, add imports:

```tsx
import ProNudgeCard from './ProNudgeCard';
import { entitlement, noteNudgeShown, nudgeState, refuseNudge, shouldNudgeForPro } from '../billing/trial';
```

Add state and the decision, near the existing `const streak = useMemo(...)`:

```tsx
  const [nudge, setNudge] = useState(false);

  // Meetings that actually finished. A meeting still processing has shown the user nothing, so it
  // is not evidence that they are getting value and must not count towards asking them to pay.
  const completed = useMemo(() => meetings.filter(m => m.status === 'done').length, [meetings]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [ent, st2] = await Promise.all([entitlement(), nudgeState()]);
      const show = shouldNudgeForPro({
        completed,
        lastShownAt: st2.lastShownAt,
        refusals: st2.refusals,
        entitlement: ent,
      });
      if (!alive) return;
      setNudge(show);
      // Recorded on render, not on eligibility: otherwise a user who never opened the library
      // would burn the offer without seeing it.
      if (show) await noteNudgeShown(completed);
    })();
    return () => {
      alive = false;
    };
  }, [completed]);
```

Render it directly above the meeting list — inside the same scroll container, above the first day section:

```tsx
      {nudge && (
        <ProNudgeCard
          meetings={completed}
          onOpen={() => {
            setNudge(false);
            navigation.navigate('Paywall');
          }}
          onDismiss={() => {
            setNudge(false);
            refuseNudge();
          }}
        />
      )}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: exit 0.

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 4: Commit**

```bash
git add src/screens/ProNudgeCard.tsx src/screens/LibraryScreen.tsx
git commit -m "feat(billing): offer Pro again after five meetings, and stop after three refusals"
```

---

### Task 6: The tier step in onboarding

**Files:**
- Modify: `src/screens/OnboardingScreen.tsx`

- [ ] **Step 1: Add the tier state**

In `src/screens/OnboardingScreen.tsx`, add imports:

```tsx
import SignInForm from '../billing/SignInForm';
import { startTrial } from '../billing/trial';
```

Add state beside the existing `const [wantWriter, setWantWriter] = useState(false);`:

```tsx
  // Which tier the user picked at setup. null = they have not been asked yet, which is the state
  // the intro screen is in.
  const [tier, setTier] = useState<'free' | 'pro' | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);
```

- [ ] **Step 2: Start the trial when Pro is chosen**

Add above `downloadAll`:

```tsx
  /**
   * Taking Pro at setup starts the TRIAL, not a purchase.
   *
   * Asking for a card before the app has transcribed a single meeting is the weakest possible ask,
   * and the trial is the only honest answer to "is it any good on MY meetings" — the only question
   * that matters for this product. Buying outright stays on the Pro screen and in Settings.
   *
   * If starting the trial fails, setup continues on free rather than dead-ending: a first run that
   * cannot proceed because a billing helper threw is a far worse outcome than a missing trial.
   */
  const choosePro = async () => {
    try {
      await startTrial();
      setTier('pro');
      setWantWriter(true);
    } catch {
      setTier('free');
      setWantWriter(false);
    }
  };
```

- [ ] **Step 3: Include the Pro models in the queue when Pro is chosen**

Replace this line:

```tsx
  const chosen = paid && wantWriter ? [...essentials, ...writer] : essentials;
```

with:

```tsx
  // `paid` covers somebody who arrived already subscribed; `wantWriter` now also comes from the
  // tier step, so a trial started thirty seconds ago pulls the writer model with everything else.
  const chosen = (paid || tier === 'pro') && wantWriter ? [...essentials, ...writer] : essentials;
```

- [ ] **Step 4: Render the tier step**

The intro screen's single "Download the AI" button becomes two choices. Replace the `<Button ... disabled={chosen.length === 0} />` block at the end of the intro screen with:

```tsx
          {tier === null ? (
            <>
              <Button
                label="Start free"
                icon="download"
                onPress={() => setTier('free')}
                disabled={essentials.length === 0}
                full
              />
              <View style={{ height: s(10) }} />
              <SoftButton
                label={`Try Pro free for 7 days`}
                icon="ai"
                onPress={choosePro}
              />
              <Txt variant="meta" color={colors.inkDim} style={{ textAlign: 'center', marginTop: s(10) }}>
                Free records, transcribes and pulls out decisions and actions — no account, forever.
                Pro adds minutes written in sentences, and downloads {writerMb} MB more.
              </Txt>
              {showSignIn ? (
                <View style={{ marginTop: s(14) }}>
                  <SignInForm onSignedIn={() => { setTier('pro'); setWantWriter(true); }} />
                </View>
              ) : (
                <SoftButton
                  label="Already subscribed? Sign in"
                  icon="lock"
                  onPress={() => setShowSignIn(true)}
                />
              )}
            </>
          ) : (
            <Button
              label={`Download ${totalMb > 0 ? `(${totalMb} MB)` : ''}`.trim()}
              icon="download"
              onPress={downloadAll}
              disabled={chosen.length === 0}
              full
            />
          )}
```

`SoftButton` and `View` must be in this file's imports; add them if missing.

- [ ] **Step 5: Confirm the later sell still fires**

Search the file for `markPaywallSeen`:

```bash
grep -n "markPaywallSeen" src/screens/OnboardingScreen.tsx
```

Expected: **no matches.** If there is one, remove it. Marking the paywall seen here would rob every free-choosing user of the offer at the strong moment — after they have watched the app work on their own meeting — which is the whole point of keeping that screen.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit`
Expected: exit 0.

Run: `npm test`
Expected: all suites pass, 124+ tests.

- [ ] **Step 7: Commit**

```bash
git add src/screens/OnboardingScreen.tsx
git commit -m "feat(onboarding): choose free or Pro at setup, without an account"
```

---

### Task 7: Device pass

**Files:** none — this is verification.

- [ ] **Step 1: Build and install**

```bash
cd android && ./gradlew assembleDebug
~/Library/Android/sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **Step 2: Walk the free path**

Uninstall first so onboarding runs (`adb uninstall com.innocorelabs.verbale`). Then: intro → **Start free** → 114 MB downloads → All set → Library. Confirm the download is 114 MB and not 1.3 GB.

- [ ] **Step 3: Walk the Pro path**

Uninstall and reinstall. Intro → **Try Pro free for 7 days** → confirm the download size becomes ~1.3 GB and that `qwen-instruct-q4_k_m.gguf` appears in the nginx access log on the mirror:

```bash
ssh root@69.62.82.85 'grep qwen /var/log/nginx/access.log | tail -3'
```

- [ ] **Step 4: Confirm the later sell still appears for free users**

On the free install, import or record a meeting and let it finish. The full-screen Pro page should appear once. Confirm it now shows "Already subscribed? Sign in".

- [ ] **Step 5: Confirm the nudge**

With five finished meetings on a free install, reopen the library and confirm the card appears above the list. Tap "Not now" twice more across three thresholds and confirm it stops returning.

- [ ] **Step 6: Commit nothing; report findings**

If any step fails, fix it as its own commit referencing the task that introduced it.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Tier step in onboarding | 6 |
| Free = no account | 6 (Step 4 — free path touches no account code) |
| Pro starts the trial | 6 (Step 2) |
| Sign-in during onboarding | 6 (Step 4) |
| Post-first-meeting screen unchanged, not marked seen early | 6 (Step 5) |
| Recurring nudge rule | 1 |
| Nudge persistence + hard stop | 2 |
| Nudge card UI | 5 |
| Sign-in on the paywall | 3, 4 |
| No Kotlin mirror | Architecture note — nothing in tasks 1–6 touches Kotlin |
| Play Billing unavailable degrades | 6 (Step 4 — the tier step offers trial and sign-in only; the price lives on the Pro screen, which already handles a missing price) |
| Trial already used | 1 (`entitlement.paid` false → nudge still offered; Pro screen already offers purchase not a second trial) |
| Pro download failure survivable | Existing behaviour, unchanged — `downloadAll` already only fails setup for a required model |
| Meeting count = reached `done` | 5 (Step 2) |

**Placeholders:** none. Every code step carries the code.

**Type consistency:** `NudgeInput`/`NudgeState` defined in Tasks 1–2 and used with the same field names in Task 5. `shouldNudgeForPro`, `nudgeState`, `noteNudgeShown`, `refuseNudge` spelled identically throughout. `SignInForm`'s `onSignedIn` prop is optional and used in three places, all matching.

**Verified against the codebase while writing this plan:**
- `refreshLicence` exists in `SettingsScreen.tsx:145` — Task 3's name is correct.
- `s`, `useTheme` and `Colors` all come from the barrel `../theme` (see `LibraryScreen.tsx:29`), not from
  `theme/scale` or `theme/ThemeContext`. Import lines above use the barrel.
- `cardTitle` and `meta` are real `Txt` variants (`palette.ts`, `TypeKey`).
- `OnboardingScreen.tsx` contains no `markPaywallSeen` call today, so Task 6 Step 5 is a guard
  against regression rather than a removal.
- `MeetingStatus` is `'done'`, not `'READY'` — the library relabels it for display. Task 5 filters
  on `'done'`.

**One thing the implementer must read before editing:** Task 6 Step 4 replaces JSX relative to the
existing `Button` at the end of the intro screen. Read the surrounding render first; the file uses a
`status` state machine (`'intro' | 'downloading' | 'done' | 'failed'`) and the replacement belongs in
the intro branch only.
