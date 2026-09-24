# Phase A — buying works, and the app always knows you are Pro — execution sheet

*24 September 2026, against `c6caccf`. For the two sessions that build it. Every file, anchor,
string and rule below was grepped today. Do not design anything: where this sheet names copy, a
rule or a status code, it is the decided answer. The plan and to-do list:
`docs/superpowers/plans/2026-09-24-tier-1-fixes.md` (items A1–A6).*

**What is wrong today (all verified in the code):**

- **A1.** `SettingsScreen.tsx:185` calls `buyWithPlay()` with no plan; `BillingModule.purchase`
  refuses that when the product has two base plans. "Subscribe" in Settings can never buy.
- **A2.** `subscription.ts` `redeem` re-throws every server failure, so Play charges the buyer and
  the app says "Could not complete the purchase". A payment still authorising (server answers
  **402**) is silent.
- **A3.** The licence is renewed only at a cold start (`App.tsx:26`), and a purchase the app never
  heard back about is only picked up if Settings is opened.
- **A4.** When the token lapses, the Summary tab shows "Your subscription has ended…" with no
  button — even when the phone merely could not check. Manage is shown only to paid users; the
  Pro screen has no Restore.
- **A5.** `LibraryScreen.tsx` reads `paid` only when the finished-meeting count changes, so after
  buying, Search/Actions/Threads still open the paywall until a restart. Settings reads the licence
  once, on mount.
- **A6.** The device id is kept in the app's own database (`LicenceStore.deviceId`), so a reinstall
  or "clear data" is a new device, and `Store.touch_device` refuses a fourth one for good — a
  paying customer who reinstalls twice is locked out.

**Decided:**

- The licence server's answers mean: **network failure or HTTP ≥ 500** → the payment stands, the
  server will be asked again → `{ paid: false, pendingServer: true }`; **402** → payment still
  authorising → `{ paid: false, pendingPayment: true }`, not acknowledged (a pending purchase
  cannot be); **200 with no token** → no active subscription → `{ paid: false }`; **any other 4xx**
  → an error with the server's message.
- At the device limit, the device **seen least recently** is dropped to make room (its refresh key
  goes with its row). The limit stays 3.

**Two sessions.** Session A1 = Steps 1–4 (server, billing logic, app start). Session A2 = Steps
5–10 (screens, gate, report). No device in either.

---

## 0. Rules

- **Token discipline.** Read only the files and line ranges in §1. Never print a file over 200
  lines; `grep -n` to locate, then `sed -n 'A,Bp'` for at most 60 lines. `SettingsScreen.tsx`,
  `PaywallScreen.tsx`, `RecordScreen.tsx`, `SummaryTab.tsx`, `LibraryScreen.tsx` are all over 500
  lines: only the ranges named. Every command ends in its filter — run it exactly as written. Do
  not re-read a file after editing it. Do not paste code into your messages; commit it and name it.
- **TDD + mutant.** Test first, watch it fail, write the code, watch it pass, apply the **named
  mutant**, watch the test fail, restore, green again. Record each mutant in the progress file as
  it happens. Never run a mutation-restore in the background.
- **Commit after each step**, subject in the house style (`git log --oneline -6`). **Never push.**
- **No device, no adb.** Never run `connectedDebugAndroidTest`, any `adb` command, or the bare
  `scripts/gate.sh`: it runs a device stage by itself when a phone is attached and cannot be
  interrupted. Use ONLY the `STAGES=…` form given in Step 10.
- **Indent like the surrounding file**: two spaces in TS/Kotlin, four in Python.
- **Progress file.** First action of Session A1: create
  `docs/superpowers/reports/phase-a-progress.md` with Steps 1–10 as checkboxes and headings
  *Decisions*, *Mutants*, *Notes for the next session*. Update and commit it with every step.
  Session A2 reads it first.
- **Hand-over at 150 steps**: finish the step you are on, commit, update the progress file, stop.
- **`git status` must be clean before you stop.**

---

## 1. Relevant files (the only files you read)

| File | Lines | Why |
|---|---|---|
| `server/app/store.py` | 405–445 | Step 1 |
| `server/app/legal.py` | 144–148 | Step 1 (wording) |
| `server/tests/test_store.py` | 1–10, 58–66 | Step 1 |
| `server/tests/test_entitlement.py` | 1–24, 98–104 | Step 1 |
| `server/tests/test_api.py` | 1–30, 72–82 | Step 1 |
| `src/billing/subscription.ts` | 1–60, 126–175, 263–290 | Steps 2, 3 |
| `src/billing/__tests__/playPurchase.test.ts` | all (≈125) | Steps 2, 3 |
| `App.tsx` | all (≈40) | Step 4 |
| `src/screens/SettingsScreen.tsx` | 38–52, 125–222, 330–360, 626–700 | Step 5 |
| `src/screens/PaywallScreen.tsx` | 18–30, 144–150, 258–300, 470–495 | Step 6 |
| `src/screens/__tests__/PaywallScreen.test.tsx` | all (≈140) | Step 6 |
| `src/screens/RecordScreen.tsx` | 36–42, 455–480 | Step 7 |
| `src/screens/meeting/SummaryTab.tsx` | 1–25, 170–230, 405–450, 505–525 | Step 8 |
| `src/screens/meeting/__tests__/SummaryTab.test.tsx` | 1–75 | Step 8 |
| `android/app/src/main/java/com/innocorelabs/verbale/billing/LicenceModule.kt` | 20–40 | Step 8 |
| `src/screens/LibraryScreen.tsx` | 262–300 | Step 9 |
| `src/screens/__tests__/LibraryScreen.test.tsx` | 1–85 | Step 9 |

**Interfaces you use without reading their files:** `Licence.status(): Promise<{ state: 'none' |
'active' | 'expired'; paid: boolean; expiresAt: number; lapsedCopy: string; … }>`;
`Billing.restore(): Promise<string | null>` (only PURCHASED purchases);
`Billing.acknowledgeLocally(token)`; `Button`, `SoftButton`, `Txt` from `src/components/ui`.

## 2. Files that must not change

- `android/app/src/main/java/com/innocorelabs/verbale/billing/BillingModule.kt`, `OfferChoice.kt`,
  `LicenceStore.kt`, `Licence.kt`, `server/app/play.py`, `server/app/billing.py`,
  `server/app/entitlement.py`, `server/app/main.py`.
- `src/billing/trial.ts`, `src/billing/trialTerms.ts`, `src/native/*`.

---

## 3. Implementation sequence

### Session A1 — server, billing logic, app start

#### Step 1. Server: at the device limit, the least recently seen device makes room

**Tests first.**

1. `server/tests/test_store.py`: replace the whole test
   `test_devices_stop_at_the_limit_but_known_ones_always_re_register` with:

```python
def test_at_the_limit_the_least_recently_seen_device_makes_room(store, monkeypatch):
    """A reinstall is a new device id. Refusing it locked paying customers out for good."""
    account = store.create_account("a@example.com", "password123")
    clock = iter([100, 200, 300, 400, 500])
    monkeypatch.setattr("app.store.time.time", lambda: next(clock))
    for d in ("phone", "tablet", "old-install"):
        assert store.touch_device(account.id, d)          # seen at 100, 200, 300
    assert store.touch_device(account.id, "phone")        # 400: the phone is fresh again
    assert store.touch_device(account.id, "reinstall")    # 500: the tablet (200) is the stalest
    ids = {d.device_id for d in store.devices(account.id)}
    assert ids == {"phone", "old-install", "reinstall"}
    assert len(ids) == DEVICE_LIMIT
```

   (`store.devices()` returns `Device` dataclasses — attribute access, not keys.)

2. `server/tests/test_entitlement.py`: replace `test_a_device_over_the_limit_gets_no_token` with:

```python
def test_a_fourth_device_still_gets_a_token(store, signing_key):
    """A reinstall looks like a new device; it must never be the thing that locks someone out."""
    account = _entitled_account(store)
    for i in range(DEVICE_LIMIT):
        assert issue(store, signing_key, account.id, f"dev_{i}", NOW) is not None
    assert issue(store, signing_key, account.id, "one_more", NOW) is not None
```

3. `server/tests/test_api.py`: replace `test_the_fourth_device_is_told_what_to_do_about_it` with:

```python
def test_a_fourth_device_signs_in(client, store):
    make_paid(store)
    for i in range(DEVICE_LIMIT):
        client.post("/api/account/signin", json={"email": "a@example.com",
                                                 "password": "password123", "deviceId": f"d{i}"})
    r = client.post("/api/account/signin", json={"email": "a@example.com",
                                                 "password": "password123", "deviceId": "d_extra"})
    assert r.status_code == 200
    assert r.json()["token"]
```

Run: `cd server && .venv/bin/python -m pytest -q tests/test_store.py tests/test_entitlement.py tests/test_api.py 2>&1 | tail -5`
→ 3 failed.

**Code.** In `server/app/store.py` `touch_device`:

- Replace the docstring's second paragraph (`Returns False when the account is at its limit and
  this is a new device. A device already on the list always succeeds, so reinstalling the app or
  refreshing a token can never be the thing that locks someone out of their own subscription.`)
  with:

```python
        Always succeeds. At the limit, the device seen least recently makes room, and its refresh
        key goes with its row. The device id lives in the app's own storage, so a reinstall or
        "clear data" arrives as a new device; refusing it locked paying customers out after a
        couple of reinstalls. The limit still bounds how many installs are live at once.
```

- Replace

```python
            if count >= DEVICE_LIMIT:
                return False
```

  with

```python
            if count >= DEVICE_LIMIT:
                stalest = self._db.execute(
                    "SELECT device_id FROM devices WHERE account_id=? "
                    "ORDER BY last_seen ASC, first_seen ASC LIMIT 1",
                    (account_id,),
                ).fetchone()
                self._db.execute(
                    "DELETE FROM devices WHERE account_id=? AND device_id=?",
                    (account_id, stalest["device_id"]),
                )
```

In `server/app/legal.py`, replace
`<li>One subscription covers up to {DEVICE_LIMIT} devices. You can change which devices from your`
`      account page.</li>` with
`<li>One subscription covers up to {DEVICE_LIMIT} devices at a time. Using it on another one`
`      signs out the device used least recently.</li>`.

Leave `main.py`'s two `409` branches as they are (they are now unreachable; §2 forbids the edit).

Run the three files → passed. Then the full suite:
`cd server && .venv/bin/python -m pytest -q 2>&1 | tail -3` → `passed`, 0 failed. If another test
asserted the old refusal, it fails here: update only its expectation to the new rule and record it.

**Mutant M1:** put `return False` back as the first line inside `if count >= DEVICE_LIMIT:`. All
three new tests must fail. Restore.

Commit: `fix(server): a reinstall can never lock a subscriber out — the stalest device makes room`.

#### Step 2. `redeem` says what actually happened

**Tests first.** In `src/billing/__tests__/playPurchase.test.ts`:

- Below the `ok` helper add:

```ts
const refuse = (status: number, error: string) =>
  Promise.resolve({ ok: false, status, text: async () => JSON.stringify({ error }) } as Response);
```

- Replace the test `acknowledges the purchase locally when the server cannot be reached` with:

```ts
  it('a server it cannot reach is "payment received", not a failure', async () => {
    // Google refunds anything unacknowledged after three days, so it is acknowledged here; and the
    // buyer has paid, so the app must not say the purchase failed.
    Billing.purchase.mockResolvedValue('token-abc');
    (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));

    await expect(buyWithPlay('annual')).resolves.toEqual({ paid: false, pendingServer: true });
    expect(Billing.acknowledgeLocally).toHaveBeenCalledWith('token-abc');
  });

  it('a server or Google failure (5xx) is treated the same way', async () => {
    Billing.purchase.mockResolvedValue('token-abc');
    (global.fetch as jest.Mock).mockReturnValue(refuse(502, 'Play API 500'));
    await expect(buyWithPlay('annual')).resolves.toEqual({ paid: false, pendingServer: true });
    expect(Billing.acknowledgeLocally).toHaveBeenCalledWith('token-abc');
  });

  it('a payment still authorising says so and is not acknowledged', async () => {
    Billing.purchase.mockResolvedValue('token-abc');
    (global.fetch as jest.Mock).mockReturnValue(refuse(402, 'That purchase has not completed yet.'));
    await expect(buyWithPlay('annual')).resolves.toEqual({ paid: false, pendingPayment: true });
    expect(Billing.acknowledgeLocally).not.toHaveBeenCalled();
  });

  it('a refusal the buyer can act on is still an error, with the server\'s words', async () => {
    Billing.purchase.mockResolvedValue('token-abc');
    (global.fetch as jest.Mock).mockReturnValue(refuse(400, 'purchaseToken is required'));
    await expect(buyWithPlay('annual')).rejects.toThrow('purchaseToken is required');
  });
```

- In the test `does not grant Pro when the server issues no licence`, replace its two comment
  lines with `// 200 with no token: the subscription has lapsed or was cancelled past its end.`
  (its expectation `{ paid: false }` stays).

Run: `npx jest src/billing/__tests__/playPurchase.test.ts --silent 2>&1 | tail -15` → failures.

**Code.** In `src/billing/subscription.ts`:

2.1 In `post`, replace
`throw new Error(\`The licence server sent something unexpected (HTTP ${res.status}).\`);` with:

```ts
    throw withStatus(new Error(`The licence server sent something unexpected (HTTP ${res.status}).`), res.status);
```

and replace
`throw new Error(message ?? \`The licence server refused the request (HTTP ${res.status}).\`);` with:

```ts
    throw withStatus(
      new Error(message ?? `The licence server refused the request (HTTP ${res.status}).`),
      res.status,
    );
```

and directly above `async function post<T>(` add:

```ts
/**
 * An error carrying the licence server's HTTP status, which decides what the buyer is told. A
 * plain property rather than an Error subclass: a transpiled subclass of Error can fail
 * `instanceof`, and a network failure (no status at all) must stay distinguishable.
 */
function withStatus(e: Error, status: number): Error & { status: number } {
  return Object.assign(e, { status });
}

/** The HTTP status on an error from `post`, or null for a network failure. */
function statusOf(e: unknown): number | null {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}
```

2.2 Replace the `PlayResult` interface with:

```ts
export interface PlayResult {
  /** False when the buyer backed out, or when there is nothing paid to show for it yet. */
  paid: boolean;
  /**
   * Play took the payment but the licence server could not be reached, or it or Google failed.
   * The purchase is acknowledged and will be redeemed on the next launch or return to the app.
   */
  pendingServer?: boolean;
  /** The server saw the purchase but it is still authorising (HTTP 402) — a slow payment method. */
  pendingPayment?: boolean;
}
```

2.3 Replace `redeem`'s body from `const deviceId = await Licence.deviceId();` to the end of the
function with:

```ts
  const deviceId = await Licence.deviceId();
  try {
    const res = await post<{ token: string | null; refreshKey: string; plan: string }>(
      base,
      '/api/billing/play/link',
      { purchaseToken, deviceId },
    );
    await Licence.store(res.token ?? '', res.refreshKey);
    return { paid: Boolean(res.token) };
  } catch (e) {
    const status = statusOf(e);
    // Still authorising: nothing to acknowledge yet (Play refuses to), and nothing failed.
    if (status === 402) return { paid: false, pendingPayment: true };
    // Acknowledged whatever happens next: Google refunds anything unacknowledged in three days.
    await Billing.acknowledgeLocally(purchaseToken).catch(() => false);
    // Unreachable, or the server or Google failed: the payment stands and is redeemed later.
    if (status === null || status >= 500) return { paid: false, pendingServer: true };
    throw e;
  }
```

and update `redeem`'s doc comment's first paragraph to: `Send a purchase token to the licence
server and store whatever comes back. See PlayResult for what each outcome means.` (keep the rest).

Run the jest command → all pass.

**Mutant M2:** change `status >= 500` to `status > 999`. *a server or Google failure (5xx)…* must
fail. Restore.

Commit: `fix(billing): a payment that went through is never reported as a failed purchase`.

#### Step 3. `syncEntitlement` — Pro matches Play on every launch and return

**Test first.** In `playPurchase.test.ts`, add `syncEntitlement` to the import from
`'../subscription'`, and at the end of the file add:

```ts
describe('keeping Pro in step with Play', () => {
  it('asks Play nothing when this install already has Pro', async () => {
    Licence.status.mockResolvedValue({ state: 'active', paid: true, expiresAt: 0 });
    await syncEntitlement();
    expect(Billing.restore).not.toHaveBeenCalled();
  });

  it('picks up a purchase the app never heard back about', async () => {
    Licence.status.mockResolvedValue({ state: 'none', paid: false, expiresAt: 0 });
    Billing.available.mockResolvedValue(true);
    Billing.restore.mockResolvedValue('token-abc');
    (global.fetch as jest.Mock).mockReturnValue(
      ok({ token: 'licence-xyz', refreshKey: 'refresh-1', plan: 'pro' }),
    );
    await syncEntitlement();
    expect(Licence.store).toHaveBeenCalledWith('licence-xyz', 'refresh-1');
  });

  it('does nothing on an install that cannot use Play', async () => {
    Licence.status.mockResolvedValue({ state: 'none', paid: false, expiresAt: 0 });
    Billing.available.mockResolvedValue(false);
    await syncEntitlement();
    expect(Billing.restore).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    Licence.status.mockRejectedValue(new Error('native gone'));
    Billing.available.mockRejectedValue(new Error('no Play'));
    await expect(syncEntitlement()).resolves.toBeUndefined();
  });
});
```

Run the jest command → fails (no export).

**Code.** In `subscription.ts`, after `restorePlayPurchase`, add:

```ts
/** Where a Play subscriber manages, pauses, fixes payment for or cancels their subscription. */
export const PLAY_MANAGE_URL = 'https://play.google.com/store/account/subscriptions';

let syncing: Promise<void> | null = null;

/**
 * Make this install's Pro match what the buyer actually has. Run on every launch and every return
 * to the foreground; never throws, never interrupts.
 *
 * Two jobs. Renew the licence when it is near expiry or lapsed (refreshIfNeeded). And when this
 * install has no Pro, ask Play whether the Google account owns a subscription — which is what
 * picks up a purchase made while the server was unreachable, a slow payment that has since gone
 * through, or a reinstall. For a free user Play answers from its local cache with nothing, so no
 * request leaves the phone.
 *
 * One at a time: the app returning from Play's own purchase sheet fires a foreground event while
 * the purchase is being redeemed, and two redemptions of one token would race.
 */
export function syncEntitlement(): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      await refreshIfNeeded();
      const status = await Licence.status().catch(() => null);
      if (status?.paid) return;
      if (!(await playAvailable())) return;
      await restorePlayPurchase().catch(() => undefined);
    } catch {
      // Never interrupts: the next launch or return tries again.
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}
```

Run → all pass. **Mutant M3:** delete `if (status?.paid) return;`. *asks Play nothing when this
install already has Pro* must fail. Restore.

Commit: `feat(billing): syncEntitlement — Pro checked against Play on launch and on return`.

#### Step 4. The app runs it on launch and on every return

Replace `App.tsx`'s import `import { refreshIfNeeded } from './src/billing/subscription';` with
`import { syncEntitlement } from './src/billing/subscription';`, add `import { AppState } from
'react-native';` after the React import, and replace the comment block plus
`refreshIfNeeded().catch(() => {});` with:

```tsx
    // Pro follows the buyer, not the last cold start: renew a licence near expiry, and pick up a
    // purchase the app never heard back about (offline at purchase, a slow payment, a reinstall).
    // Checked again on every return to the app, where most of those resolve.
    syncEntitlement().catch(() => {});
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') syncEntitlement().catch(() => {});
    });
    return () => sub.remove();
```

Run: `npx tsc --noEmit 2>&1 | tail -5` → nothing; `npx jest --silent 2>&1 | grep -E "^Tests:|^Test Suites:"`
→ all passed.

Commit: `feat(app): check Pro on launch and on every return to the app`.

**End of Session A1.** Update the progress file, commit, stop.

---

### Session A2 — the screens

#### Step 5. Settings: Subscribe opens the Pro screen; Manage for everyone; fresh on focus

In `src/screens/SettingsScreen.tsx`:

5.1 The `../billing/subscription` import becomes:

```tsx
import {
  PLAY_MANAGE_URL,
  playAvailable,
  restorePlayPurchase,
  signOut,
} from '../billing/subscription';
```

5.2 Delete `const [playCost, setPlayCost] = React.useState<string | null>(null);`. In the effect
`playAvailable().then(async can => { setPlayCan(can); if (can) setPlayCost(await playPrice()); });`
replace the body with `playAvailable().then(setPlayCan).catch(() => {});` and its comment's
first sentence with `// Whether Play can sell here. Fails closed: no Play Store answers false.`

5.3 Delete the whole `const onBuy = React.useCallback(…);` block.

5.4 `onManage` becomes `Linking.openURL(PLAY_MANAGE_URL).catch(() => {});`.

5.5 In the SUBSCRIPTION card, replace the `<Button … onPress={onBuy} … />` element (label
`playBusy ? 'One moment…' : playCost ? …`) with:

```tsx
                  <Button
                    icon="check"
                    label="See Pro plans"
                    onPress={() => navigation.navigate('Paywall')}
                    full
                  />
```

and in the row that holds the `Restore purchase` SoftButton, after its `</View>`, add:

```tsx
                    <View style={st.flex}>
                      <SoftButton icon="settings" label="Manage in Google Play" onPress={onManage} />
                    </View>
```

(A payment problem or an account hold is fixed in Google Play; it must be reachable exactly when
Pro is off.)

5.6 In the focus listener (`const offFocus = navigation.addListener('focus', () => {`), after
`countEmpties();` add:

```tsx
      // Back from the Pro screen: a purchase made there shows here at once.
      refreshLicence();
      entitlement().then(e => setVoicesPaid(e.paid)).catch(() => {});
```

and add `refreshLicence` to that effect's dependency array.

Run `npx tsc --noEmit 2>&1 | tail -10` → nothing. Commit:
`fix(settings): Subscribe opens the plans; Manage in Google Play for everyone; fresh on focus`.

#### Step 6. The Pro screen: purchase outcomes said honestly, and Restore

**The copy module first** — create `src/billing/purchaseNotice.ts`:

```ts
import type { PlayResult } from './subscription';

/**
 * What to tell a buyer whose purchase did not end in "You are on Pro" but did not fail either.
 * Pure, so every screen that buys says the same thing and tests need no mocks.
 */
export interface Notice {
  title: string;
  body: string;
}

export function purchaseNotice(r: PlayResult): Notice | null {
  if (r.pendingServer) {
    return {
      title: 'Payment received',
      body:
        'Google Play has your payment. Verbale could not reach its server just now, so Pro will ' +
        'switch on by itself the next time the app is open with a connection. You will not be ' +
        'charged twice.',
    };
  }
  if (r.pendingPayment) {
    return {
      title: 'Payment still processing',
      body:
        'Google Play is still confirming the payment. Pro switches on by itself once it goes ' +
        'through — usually within a few minutes. There is nothing more to do.',
    };
  }
  return null;
}
```

and `src/billing/__tests__/purchaseNotice.test.ts`:

```ts
import { purchaseNotice } from '../purchaseNotice';

describe('purchaseNotice', () => {
  it('says a payment the server has not seen yet was received', () => {
    expect(purchaseNotice({ paid: false, pendingServer: true })?.title).toBe('Payment received');
  });
  it('says a slow payment is still processing', () => {
    expect(purchaseNotice({ paid: false, pendingPayment: true })?.title).toBe('Payment still processing');
  });
  it('says nothing for a success or a change of mind', () => {
    expect(purchaseNotice({ paid: true })).toBeNull();
    expect(purchaseNotice({ paid: false })).toBeNull();
  });
});
```

**Paywall tests.** In `src/screens/__tests__/PaywallScreen.test.tsx`: add
`restorePlayPurchase: jest.fn(),` to the `../../billing/subscription` mock factory, add
`restorePlayPurchase` to the import from `'../../billing/subscription'`, and add inside the
`describe`:

```tsx
  it('a payment the server has not confirmed says "Payment received", not failed', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    (buyWithPlay as jest.Mock).mockResolvedValue({ paid: false, pendingServer: true });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await render();
    await act(async () => {
      tree.root.findByProps({ label: 'Try it free for 7 days' }).props.onPress();
    });
    expect(alert.mock.calls[0][0]).toBe('Payment received');
  });

  it('offers Restore to somebody who already subscribed', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    (restorePlayPurchase as jest.Mock).mockResolvedValue({ paid: true });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await render();
    await act(async () => {
      tree.root.findByProps({ label: 'Restore purchase' }).props.onPress();
    });
    expect(restorePlayPurchase).toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toBe('Subscription restored');
  });
```

Run: `npx jest src/billing/__tests__/purchaseNotice.test.ts src/screens/__tests__/PaywallScreen.test.tsx --silent 2>&1 | tail -15`
→ the two Paywall tests fail.

**Code — `src/screens/PaywallScreen.tsx`:**

6.1 Add `restorePlayPurchase,` to the `../billing/subscription` import (alphabetical, after
`referencePrice,`) and add `import { purchaseNotice } from '../billing/purchaseNotice';` after the
`trialTerms` import.

6.2 After `const [showSignIn, setShowSignIn] = useState(false);` add
`const [restoring, setRestoring] = useState(false);`.

6.3 In `onBuy`, directly after `const result = await buyWithPlay(chosenPlan);` add:

```tsx
      // Paid but not yet confirmed, or still authorising: said as what it is, never as a failure.
      const notice = purchaseNotice(result);
      if (notice) {
        Alert.alert(notice.title, notice.body);
        return;
      }
```

6.4 After the whole `const onBuy = useCallback(…);`, add:

```tsx
  const onRestore = useCallback(async () => {
    setRestoring(true);
    try {
      const result = await restorePlayPurchase();
      const notice = purchaseNotice(result);
      if (notice) {
        Alert.alert(notice.title, notice.body);
      } else if (result.paid) {
        await load();
        Alert.alert('Subscription restored', 'Pro is back on this phone.');
      } else {
        Alert.alert('Nothing to restore', 'This Google account has no active Verbale subscription.');
      }
    } catch (e: any) {
      Alert.alert('Could not restore', String(e?.message ?? e));
    } finally {
      setRestoring(false);
    }
  }, [load]);
```

6.5 Directly above the comment block that begins `The way in for somebody who already paid — on
the website`, add:

```tsx
              {playCan && !bought ? (
                <SoftButton
                  icon="download"
                  label={restoring ? 'Checking…' : 'Restore purchase'}
                  onPress={onRestore}
                  disabled={busy !== null || restoring}
                />
              ) : null}
```

and change that block's `label="Already subscribed? Sign in"` to `label="Subscribed on the web? Sign in"`.

Run the jest command → all pass. **Mutant M4:** delete the `if (notice) { … return; }` block in
`onBuy`. *a payment the server has not confirmed…* must fail. Restore.

Commit: `fix(paywall): a paid-but-unconfirmed purchase says so; Restore on the Pro screen`.

#### Step 7. The record screen's trial button says the same

In `src/screens/RecordScreen.tsx`, add `import { purchaseNotice } from '../billing/purchaseNotice';`
after the `trialTerms` import, and directly after
`const result = await buyWithPlay(trialOffer.basePlanId);` add:

```tsx
                        const notice = purchaseNotice(result);
                        if (notice) Alert.alert(notice.title, notice.body);
```

Run `npx tsc --noEmit 2>&1 | tail -5` → nothing. Commit:
`fix(record): the cap card says "payment received" rather than nothing`.

#### Step 8. Lapsed: "Check again" and "Manage in Google Play"; the sentence stops over-claiming

**Test first.** In `src/screens/meeting/__tests__/SummaryTab.test.tsx`: add
`syncEntitlement: jest.fn().mockResolvedValue(undefined),` and
`PLAY_MANAGE_URL: 'https://play.google.com/store/account/subscriptions',` to the
`../../../billing/subscription` mock factory, add `syncEntitlement` to that file's import from
`'../../../billing/subscription'`, add `import { Alert } from 'react-native';`, and add:

```tsx
describe('a licence that has lapsed on this phone', () => {
  test('offers Check again and Manage, and Check again asks Play again', async () => {
    (Licence.status as jest.Mock).mockResolvedValue({
      state: 'expired', paid: false, expiresAt: 1, lapsedCopy: 'Pro is off on this phone.',
    });
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await renderTab({ minutes: [] });
    expect(tree.root.findAllByProps({ label: 'Manage in Google Play' }, { deep: false })).toHaveLength(1);
    await act(async () => {
      tree.root.findByProps({ label: 'Check again' }).props.onPress();
    });
    expect(syncEntitlement).toHaveBeenCalled();
  });
});
```

Run: `npx jest src/screens/meeting --silent 2>&1 | tail -15` → fails.

**Code — `src/screens/meeting/SummaryTab.tsx`:**

8.1 `import { Pressable, ScrollView, StyleSheet, View } from 'react-native';` →
`import { Alert, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';`, and the
subscription import becomes
`import { PLAY_MANAGE_URL, playAvailable, playPlans, syncEntitlement } from '../../billing/subscription';`.

8.2 After `const [lapsedCopy, setLapsedCopy] = React.useState('');` add:

```tsx
  // "Pro is off" is often "this phone could not check" — offline for a fortnight, or a refresh
  // that failed. Check again asks Play and the server now; Manage is where a payment problem or
  // an account hold is fixed. Bumping `recheck` re-runs the effect below.
  const [recheck, setRecheck] = React.useState(0);
  const [checking, setChecking] = React.useState(false);
  const onCheckAgain = React.useCallback(async () => {
    setChecking(true);
    try {
      await syncEntitlement();
      const now = await Licence.status().catch(() => null);
      if (!now?.paid) {
        Alert.alert(
          'No active subscription found',
          'Google Play has no active Verbale subscription for this Google account. If that looks ' +
            'wrong, open Manage in Google Play.',
        );
      }
    } finally {
      setChecking(false);
      setRecheck(n => n + 1);
    }
  }, []);
  const lapsedActions = (
    <View style={st.cta}>
      <SoftButton
        icon="check"
        label={checking ? 'Checking…' : 'Check again'}
        onPress={onCheckAgain}
        disabled={checking}
      />
      <SoftButton
        icon="settings"
        label="Manage in Google Play"
        onPress={() => Linking.openURL(PLAY_MANAGE_URL).catch(() => {})}
      />
    </View>
  );
```

8.3 The effect whose dependency array is `}, [prose]);` (≈line 244) becomes `}, [prose, recheck]);`.

8.4 Directly after the `{!prose && reason === 'no-model' ? ( … ) : null}` block, add:

```tsx
            {!prose && reason === 'expired' ? lapsedActions : null}
```

and in the block `{reason === 'expired' && prose ? ( <Txt … style={st.lapsed}>{lapsedCopy}</Txt> ) : null}`
replace its inner `<Txt …>{lapsedCopy}</Txt>` with:

```tsx
        <View>
          <Txt variant="chipSoft" color={colors.inkDim} style={st.lapsed}>
            {lapsedCopy}
          </Txt>
          {lapsedActions}
        </View>
```

8.5 `LicenceModule.kt`: replace the `defaultLapsedCopy` string with:

```kotlin
    "Pro is off on this phone. Your recordings, transcripts and minutes are all still here. " +
      "Still subscribed? Tap Check again while connected."
```

Run the jest command → passes; `cd android && ./gradlew :app:testDebugUnitTest 2>&1 | grep -E "BUILD|FAILED" | tail -3`
→ `BUILD SUCCESSFUL`. **Mutant M5:** in 8.4 change `{!prose && reason === 'expired' ? lapsedActions : null}`
to `{null}`. The new test must fail. Restore.

Commit: `fix(summary): a lapsed licence offers Check again and Manage, and stops over-claiming`.

#### Step 9. The Library notices Pro the moment you come back

**Test first.** In `src/screens/__tests__/LibraryScreen.test.tsx`, inside
`describe('the thread door and the Pro-gated worklist (Phase 3)', …)` add:

```tsx
  test('buying Pro on the Pro screen is noticed when the library is focused again', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const tree = await focusTheLibrary();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Actions (Pro)' }, { deep: false })).toHaveLength(1);

    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const onFocus = (nav as any).addListener.mock.calls.find((c: any[]) => c[0] === 'focus')[1];
    await act(async () => {
      onFocus();
    });
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Actions' }, { deep: false })).toHaveLength(1);
    await act(async () => tree.unmount());
  });
```

Run: `npx jest src/screens/__tests__/LibraryScreen.test.tsx --silent 2>&1 | tail -15` → fails.

**Code.** In `LibraryScreen.tsx`'s `const onFocus = () => {`, directly after the line
`db.archivedCount().then(setArchived).catch(() => {});` add:

```tsx
      // Pro is re-read on every focus, not only when the finished count moves: coming back from
      // the Pro screen after buying must unlock Search, Actions and Threads at once.
      entitlement().then(e => setPaid(e.paid)).catch(() => {});
```

Run → passes. **Mutant M6:** delete that line. The new test must fail. Restore.

Commit: `fix(library): buying Pro unlocks Search, Actions and Threads straight away`.

#### Step 10. Gate, release build, report

1. `STAGES="types js scans mutations kotlin cpp" scripts/gate.sh 2>&1 | grep -E "==>|ok |FAILED|gate:" | tail -20`
   → every stage `ok`. **Never run `scripts/gate.sh` without `STAGES=`.** Force Kotlin:
   `cd android && ./gradlew :app:testDebugUnitTest --rerun-tasks 2>&1 | grep -E "BUILD|FAILED" | tail -3`.
2. `cd server && .venv/bin/python -m pytest -q 2>&1 | tail -3` → passed.
3. `cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a 2>&1 | grep -E "BUILD|FAILED|error:" | tail -5`
   → `BUILD SUCCESSFUL`.
4. `git grep -n "buyWithPlay()" -- src` → no output. `git diff --stat c6caccf..HEAD` names only
   the files in §1 plus `src/billing/purchaseNotice.ts`, its test, the progress file, the report,
   and this sheet and `docs/superpowers/plans/2026-09-24-tier-1-fixes.md` (committed before the session).
5. Write the report (§8), delete the progress file, commit:
   `docs(report): Phase A — buying and Pro state — built, by-hand steps`.

---

## 4. Expected interfaces after this sheet

- `PlayResult = { paid; pendingServer?; pendingPayment? }`; `redeem` classifies as in *Decided*.
- `syncEntitlement(): Promise<void>` and `PLAY_MANAGE_URL` exported from `src/billing/subscription`.
- `purchaseNotice(result): { title; body } | null` in `src/billing/purchaseNotice.ts`.
- `App.tsx` calls `syncEntitlement` on mount and on every `AppState` → `active`.
- `Store.touch_device` always returns True; at the limit it deletes the least recently seen device.

## 5. Tests and commands

| Command | Must print |
|---|---|
| `cd server && .venv/bin/python -m pytest -q 2>&1 \| tail -3` | `passed`, 0 failed |
| `npx jest src/billing --silent 2>&1 \| tail -15` | all passed |
| `npx jest src/screens --silent 2>&1 \| tail -15` | all passed |
| `npx tsc --noEmit 2>&1 \| tail -5` | nothing |
| gate (Step 10.1) | every stage `ok` |
| `assembleRelease` (Step 10.3) | `BUILD SUCCESSFUL` |

Mutants M1–M6, each killed by its named test and restored.

## 6. Acceptance criteria

- §5 as stated; six mutants killed and recorded.
- `git grep -n "buyWithPlay()" -- src` → nothing; `git grep -n "playPrice" -- src/screens/SettingsScreen.tsx` → nothing.
- File set as in Step 10.4; `git status` clean.

## 7. Stop conditions

- A step needs a change in a §2 file: stop, write what and why in the progress file, commit.
- Two unsuccessful fixes of the same failing test or compile error: stop, record both attempts, commit.
- A gate stage fails in a file this session did not touch: do not investigate; record the last 20
  lines, commit.
- At 150 steps: finish the current step, commit, update the progress file, stop.

## 8. The report contract

`docs/superpowers/reports/2026-09-24-phase-a-buying-and-pro-state.md`: status in one line; what
was built per step with hashes; decisions with causes; tests table (name, result, mutant, result);
gate + pytest + assembleRelease; device: "not run — founder's by-hand session"; then §7 below
verbatim; known gaps; `git log --oneline c6caccf..HEAD`. If something was not run, say so.

**§7 — By hand, for the founder** (server deployed first: `VERBALE_HOST=root@69.62.82.85 server/deploy/deploy.sh`;
app = a new internal-testing build, version bumped):

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

## 9. The prompts that start each session

Session A1:

> Read `docs/superpowers/specs/2026-09-24-phase-a-buying-and-pro-state-execution.md` and execute
> Session A1 exactly as written: Steps 1–4, under its token rules. Stop after committing Step 4 and
> the progress file, when a stop condition is met, or at 150 steps. Do not push.

Session A2:

> Read `docs/superpowers/specs/2026-09-24-phase-a-buying-and-pro-state-execution.md` and then
> `docs/superpowers/reports/phase-a-progress.md`. Execute Session A2 exactly as written: Steps
> 5–10, under its token rules. Stop when the report is committed, when a stop condition is met, or
> at 150 steps. Do not push.

## 10. Deliberately NOT in this sheet

- Showing trial-ending / grace / account-hold / renewal dates (needs the server to return them —
  Tier 2).
- Handling Play purchase updates that arrive with no purchase flow open (`BillingModule` §2) —
  `syncEntitlement` on return covers the same cases without touching native billing.
- Removing `main.py`'s now-unreachable 409 branches.
