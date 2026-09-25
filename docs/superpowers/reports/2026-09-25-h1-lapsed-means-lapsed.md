# H1 — lapsed means lapsed — report

*25 September 2026. Builder session against
`docs/superpowers/specs/2026-09-25-h1-lapsed-means-lapsed-execution.md`. Started at `155b17f`,
committed as `ae33b43`.*

## What changed

- [src/billing/subscription.ts:136-143](src/billing/subscription.ts#L136-L143) — `refreshIfNeeded`:
  a `200` with no token now does `await Licence.store('', null)` and returns `await
  Licence.status()`, instead of returning `null` and leaving the old token in place.
- [src/billing/subscription.ts:110-111](src/billing/subscription.ts#L110-L111) — doc comment above
  `refreshIfNeeded` gained the closing sentence: *"A server that answers "not entitled" is
  different: that is news, and the token is dropped at once."*
- [src/billing/__tests__/playPurchase.test.ts](src/billing/__tests__/playPurchase.test.ts) —
  `refreshIfNeeded` added to the import; new `describe('renewing the licence', …)` block appended
  at the end of the file, four tests, exactly as the sheet specified.

No other file touched. Anchors matched the sheet exactly at the start (line 135 was
`if (!res.token) return null;`, unchanged since `9d63098`).

## Step 1 — test first

`npx jest src/billing/__tests__/playPurchase.test.ts` before the fix: 23 passed, 1 failed —
`renewing the licence › forgets a token the server no longer backs, and keeps the refresh key`,
on `expect(Licence.store).toHaveBeenCalledWith('', null)` (0 calls). The other three new tests and
all 20 pre-existing tests passed. Matches the sheet's expectation exactly.

## Step 2 — the fix

Applied as specified. Re-ran the file: 24/24 passed.

## Step 3 — mutants

| # | Mutant | Must fail | Result | Jest line |
|---|---|---|---|---|
| M1 | delete `await Licence.store('', null);` | forgets a token the server no longer backs… | **Failed** — `Licence.store` had 0 calls, expected `('', null)` | `playPurchase.test.ts:224` |
| M2 | replace with `await Licence.clear();` | forgets a token the server no longer backs… | **Failed** — same assertion, `Licence.store` still 0 calls (clear() isn't store()) | `playPurchase.test.ts:224` |
| M3 | in `catch`, add `await Licence.store('', null);` before `return null` | keeps the token when the server cannot be reached | **Failed** — `expect(Licence.store).not.toHaveBeenCalled()` saw 1 call: `("", null)` | `playPurchase.test.ts:240` |
| M4 | remove the `if (!res.ok)` throw in `post` (lines 58-64) | keeps the token when the server fails | **Failed** — `expect(refreshIfNeeded(NOW)).resolves.toBeNull()` received the status object instead (the 503 body parsed as a normal response, so `res.token` was `undefined`... string falsy check took the "no token" branch and returned status, not null) | `playPurchase.test.ts:246` |

Each mutant was reverted by hand immediately after its run. After M4's revert, `git diff --stat`
and `git diff src/billing/subscription.ts` showed exactly the Step 1–2 changes, nothing else.

## Step 4 — gate and commit

```
GATE_STAGES="types js scans" scripts/gate.sh
```

Tail:

```
==> types
    ok  types (9s)
==> js
Test Suites: 66 passed, 66 total
Tests:       636 passed, 636 total
    ok  js (13s)
==> scans
network egress OK (213 files)
prompt fencing: OK (42 files)
Ran 33 tests in 1.450s
OK
diarization constants OK (windowing off, pad 500 ms)
engine encapsulation OK
live transcript: cache-only invariant holds
    ok  scans (4s)

gate: all clear in 26s
```

(The `js` stage also printed a pre-existing, unrelated `ReferenceError: ... Jest environment after
it has been torn down` from `ActionsScreen.test.tsx` and a "worker process failed to exit
gracefully" notice — both informational noise around suites that still reported `PASS`, not
failures, and neither touches `src/billing`.)

Commit: `ae33b435db6ba8be68fb4fd299347423694e244c` —
`fix(billing): a lapsed subscription stops being Pro at the next refresh`. Not pushed.

## Acceptance

- `npx jest src/billing` — 6 suites, 69 tests, all passed.
- `git diff 9d63098..HEAD --stat` shows `src/billing/subscription.ts`,
  `src/billing/__tests__/playPurchase.test.ts`, this report, and the execution-sheet spec file
  itself (committed in `155b17f`, one commit before this session started — not added by this
  session).
- Gate stages `types js scans` passed.

## Anything unexpected

Nothing. No stop condition was hit; no "must not change" file was touched; every mutant failed its
named test on the first try.
