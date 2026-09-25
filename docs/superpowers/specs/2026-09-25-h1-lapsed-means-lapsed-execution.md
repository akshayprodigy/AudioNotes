# H1 — lapsed means lapsed — execution sheet

*25 September 2026. Hotfix 1 of `docs/superpowers/plans/2026-09-25-fix-plan-after-a07-pass.md`
(defect 2 of `docs/superpowers/reports/2026-09-25-a07-play-build-feature-pass.md`). One builder
session, one commit. Anchors grepped on 25 Sep against `9d63098`.*

## The defect

When a subscription ends, the licence server's `/api/licence/refresh` answers **200** with
`{"token": null, "plan": "free", "expiresAt": 0}` (`server/app/main.py` 108–128). The app ignores
that answer — `src/billing/subscription.ts:135` `if (!res.token) return null;` — and keeps its old
token, which was minted with the 3-day payment grace. Seen on the A07: server row `cancelled`,
period ended 51 minutes earlier, app still Pro after four refreshes.

## The decision (already made, do not revisit)

On a **200 with no token**, forget the token but **keep the refresh key**:
`await Licence.store('', null)`.

- **Not `Licence.clear()`.** `clear` also blanks the refresh key (`LicenceStore.kt` 109–113). The
  key is what lets a later refresh pick up a renewal or resubscription made on the web; wiping it
  would force a password sign-in. `store(token, null)` keeps the stored key (`LicenceStore.kt`
  92–97: the key is written only when non-blank). `signIn` already stores `''` the same way (line 96).
- An empty token verifies as `NONE` (`Licence.kt:84`), so `Licence.status()` reads `paid: false`
  immediately, and `syncEntitlement` (line 352 onward) then asks Play, which is correct.
- **A network failure, a 5xx, or any other thrown error keeps the token.** Riding out an outage is
  what the token's remaining life is for. The `catch` stays as it is.

## Files

| File | Lines | Change |
|---|---|---|
| `src/billing/subscription.ts` | 104–141 (`refreshIfNeeded`) | the fix + its comment |
| `src/billing/__tests__/playPurchase.test.ts` | append at the end of the file | a new `describe` |

## Must not change

- Anything else in `subscription.ts`: `signIn`, `redeem`, `buyWithPlay`, `syncEntitlement`,
  `purchasing`, the `RENEW_WINDOW_SECONDS` gate on lines 117–127.
- `NativeLicence.ts`, `LicenceStore.kt`, `Licence.kt`, `jest.setup.js`, the server.
- `SummaryTab.tsx`. After this fix a server-lapsed install reads `none` (the Free state), not
  `expired`. That is intended; do not add a "lapsed" flag.
- The 401 "Sign in again" path. It still lands in `catch` and keeps the token. That is out of
  scope here; do not touch it.

## Steps

### Step 1 — the test first (it must fail before Step 2)

Append to `src/billing/__tests__/playPurchase.test.ts`. Add `refreshIfNeeded` to the existing
import from `'../subscription'`.

```ts
describe('renewing the licence', () => {
  const NOW = 1_800_000_000;
  // Inside the renew window, so refreshIfNeeded actually asks the server.
  const nearExpiry = { state: 'active', paid: true, expiresAt: NOW + 2 * 24 * 60 * 60 };

  beforeEach(() => {
    Licence.status.mockResolvedValue(nearExpiry);
    Licence.refreshKey.mockResolvedValue('refresh-1');
  });
  // The key would otherwise leak into later files' syncEntitlement calls through the shared stub.
  afterEach(() => {
    Licence.refreshKey.mockResolvedValue(null);
  });

  it('forgets a token the server no longer backs, and keeps the refresh key', async () => {
    (global.fetch as jest.Mock).mockReturnValue(ok({ token: null, plan: 'free', expiresAt: 0 }));
    await refreshIfNeeded(NOW);
    expect(Licence.store).toHaveBeenCalledWith('', null);
    // clear() would also wipe the refresh key, and a web resubscription could not be picked up.
    expect(Licence.clear).not.toHaveBeenCalled();
  });

  it('stores a renewed token', async () => {
    (global.fetch as jest.Mock).mockReturnValue(
      ok({ token: 'licence-new', plan: 'pro', expiresAt: NOW + 14 * 24 * 60 * 60 }),
    );
    await refreshIfNeeded(NOW);
    expect(Licence.store).toHaveBeenCalledWith('licence-new', null);
  });

  it('keeps the token when the server cannot be reached', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError('Network request failed'));
    await expect(refreshIfNeeded(NOW)).resolves.toBeNull();
    expect(Licence.store).not.toHaveBeenCalled();
    expect(Licence.clear).not.toHaveBeenCalled();
  });

  it('keeps the token when the server fails', async () => {
    (global.fetch as jest.Mock).mockReturnValue(refuse(503, 'down'));
    await expect(refreshIfNeeded(NOW)).resolves.toBeNull();
    expect(Licence.store).not.toHaveBeenCalled();
    expect(Licence.clear).not.toHaveBeenCalled();
  });
});
```

Run `npx jest src/billing/__tests__/playPurchase.test.ts`. **Expected before the fix:** the first
test fails and the other three pass. If any other test fails, stop (see Stop conditions).

### Step 2 — the fix

In `src/billing/subscription.ts`, replace line 135:

```ts
    if (!res.token) return null;
```

with:

```ts
    if (!res.token) {
      // The server answered and said no: the subscription has ended. Forget the token now rather
      // than riding out the payment grace it was minted with. The refresh key stays, so a
      // renewal on the web is still picked up by the next refresh without a password. Only an
      // answer does this. A failure to get one lands in the catch below and keeps the token.
      await Licence.store('', null);
      return await Licence.status();
    }
```

Also update the doc comment above `refreshIfNeeded` (lines 104–111) with one sentence at the end
of its second paragraph: *"A server that answers "not entitled" is different: that is news, and
the token is dropped at once."*

Re-run the test file. All tests pass.

### Step 3 — mutants (each must fail the named test; revert each by hand, then `git diff` must show only Steps 1–2)

| # | Mutant | Must fail |
|---|---|---|
| M1 | delete the `await Licence.store('', null);` line | forgets a token the server no longer backs… |
| M2 | replace it with `await Licence.clear();` | forgets a token the server no longer backs… |
| M3 | in the `catch`, add `await Licence.store('', null);` before `return null` | keeps the token when the server cannot be reached |
| M4 | change `refuse(503…)`'s path: in `post`, remove the `if (!res.ok)` throw (lines 58–64) | keeps the token when the server fails |

Record in the report which test failed for each mutant, with the jest line.

### Step 4 — gate and commit

```sh
GATE_STAGES="types js scans" scripts/gate.sh
```

(`GATE_STAGES`, not `STAGES`. No Kotlin, C++ or reconciler change, so those stages are skipped.)

Commit: `fix(billing): a lapsed subscription stops being Pro at the next refresh`, with a body
naming defect 2 and why it uses `store('', null)` instead of `clear()`. **Do not push.**

## Acceptance

- `npx jest src/billing` is green; the four new tests exist and each mutant M1–M4 failed its named test.
- `git diff 9d63098..HEAD --stat` shows exactly the two files above (and the report).
- Gate stages `types js scans` pass.

## Stop conditions — stop and report instead of improvising

- An existing test in `src/billing` fails after Step 1 (the shared stub state is leaking): report
  which one; do not edit existing tests.
- The anchors above are not where this sheet says (someone changed the file since `9d63098`).
- Any mutant survives.
- The fix seems to need a change in any "must not change" file.

## Report

Write `docs/superpowers/reports/2026-09-25-h1-lapsed-means-lapsed.md`: what changed (file:line),
test output, the mutant table with results, gate output tail, commit hash, anything unexpected.
