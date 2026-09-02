# Play-only billing and admin console — implementation plan

Spec: `docs/superpowers/specs/2026-09-02-play-only-billing-and-admin-console-design.md`

## Before you start

```bash
cd server
python3 -m venv .venv                        # not checked in; create it once
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q                # must be green BEFORE you change anything
```

Everything in this plan is server-side. **No Android or JS file changes** — the app never knew
about Razorpay, so nothing on the client moves.

### Three things that will bite you

1. **`_migrate` is not `CREATE TABLE IF NOT EXISTS`.** Bump `SCHEMA_VERSION` and add a `version <
   N` block. A table rebuild must turn foreign keys off first, and must not turn them back on
   inside the transaction — read the existing comments before adding to them.
2. **The deletion guard has to keep working at every commit.** Do not delete
   `cancel_subscription` before its Play replacement exists and is wired in. Task order matters:
   1 → 2 → 4, never 4 first.
3. **`.env.example` is documentation that gets copied to production.** A key removed from the code
   and left in the example is how a deploy grows a variable nobody can explain.

---

# Part A — Razorpay comes out

## Task A0: Pin what must not change — ALREADY DONE

Checked before writing anything, and the characterization this plan called for already exists:

- `tests/test_entitlement.py` — `test_active_is_entitled`, `test_none_is_never_entitled`,
  `test_past_due_survives_the_grace_window_and_not_a_second_longer`,
  `test_cancelled_runs_to_the_end_of_the_period_already_paid_for`, `test_cancelled_gets_no_grace_on_top`.
- `tests/test_account_deletion.py` — `test_nothing_is_deleted_when_the_provider_will_not_cancel`,
  plus the paid and past_due cancellation paths.

So the guarantee Part A must preserve is already pinned by tests that will fail if the refactor
breaks it. Writing a second copy would add nothing. **Baseline: 164 tests pass** (`server/README.md`
says 87 — stale, corrected in A6).

The one thing to note: `test_account_deletion.py` monkeypatches `pages.cancel_subscription` by
name, so renaming that symbol in A2 requires updating the fixture in the same commit or the tests
silently patch nothing and start hitting the network.

## Task A1: `play.cancel()`

1. In `server/app/play.py`, add:
   ```python
   def cancel(purchase_token: str, product_id: str) -> None:
   ```
   POSTing to `/applications/{package}/purchases/subscriptions/{product_id}/tokens/{token}:cancel`
   via the existing `_post`. Same quoting as `acknowledge`.
2. Unit-test it against a stubbed `_post`: correct path, correct quoting of a token containing `/`.

## Task A2: `billing.cancel_play_subscription()` and the deletion path

1. Add to `billing.py`:
   ```python
   def cancel_play_subscription(provider_id: str) -> tuple[bool, str | None]:
   ```
   - `play.verify(provider_id)` to get `product_id`.
   - If the subscription is already `cancelled` (or Google 404s the token), return `(True, None)` —
     it is in the state we wanted.
   - Otherwise `play.cancel(...)`, return `(True, None)`.
   - Any `PlayError` → `(False, message)`.
2. Point `pages.py:483` at it. Keep the guard and the 502 page exactly as they are — only the
   function name changes.
3. Rewrite the comment there: it says "Razorpay charging the card"; it is Google now.
4. A0's deletion test must still pass, plus a new one for "already cancelled counts as success".

## Task A3: Delete the Razorpay endpoints

1. `main.py`: remove `POST /api/billing/subscribe` and `POST /api/billing/webhook`, and their
   imports.
2. `pages.py`: remove the web checkout page, its form and its route; remove the `start_subscription`
   import.
3. Delete the now-dead tests in `test_billing.py` and `test_api.py`. **Read each one before
   deleting** — anything asserting entitlement rather than Razorpay mechanics moves to A0's file
   instead of being thrown away.

## Task A4: Delete the Razorpay implementation

1. From `billing.py`: `plan_id`, `_client`, `webhook_signature_matches`, `map_status`,
   `SubscribeResult`, `start_subscription`, `apply_webhook`, `cancel_subscription`.
2. Rewrite the module docstring. It currently opens "Becoming entitled, by either route" and
   explains a two-provider design that no longer exists.
3. `requirements.txt`: drop `razorpay`.
4. `grep -ri razorpay server/app` must return nothing but deliberate historical notes.

## Task A5: `provider` defaults to `play`

1. `store.py`: `DEFAULT 'razorpay'` → `DEFAULT 'play'` in the schema; `Subscription.provider`
   default; `account_by_provider_id(provider="play")`.
2. Bump `SCHEMA_VERSION` and add the migration block:
   ```sql
   UPDATE subscriptions SET provider = 'play' WHERE provider = 'razorpay'
   ```
   No table rebuild — this is a data update, not a shape change.
3. Extend `test_migration.py`: a database written at the old version, with a `razorpay` row, comes
   out as `play` with the account and subscription **still present**. The existing migration test
   is the model for this.

## Task A6: The claims that are now false

1. `legal.py`: remove Razorpay as a named payment processor and describe Google Play as the
   processor. This is a factual statement to users in a privacy policy — get the wording right,
   do not just delete the noun.
2. `entitlement.py`: rewrite `PAYMENT_GRACE_SECONDS`'s docstring per spec A3 — Play's
   `IN_GRACE_PERIOD` and `ON_HOLD`, not Razorpay's retries. **The constant does not change.**
3. `.env.example`, `README.md`, `deploy/nginx/verbale.conf` (webhook location block),
   `deploy/seed-test-account.sh` (`provider='play'`), `docs/play-console.md`.

## Task A7: Green

`.venv/bin/python -m pytest -q`. Expect fewer tests than the 87 in the README; update that number
in the same commit rather than leaving it stale.

---

# Part B — the admin console

## Task B1: `server/app/admin_auth.py`

1. Config from the environment, read once:
   - `ADMIN_SESSION_SECRET` — no default. Missing ⇒ console disabled.
   - `VERBALE_ADMIN_EMAILS` — comma-separated, lowercased, stripped. Empty ⇒ console disabled.
2. `def enabled() -> bool`, `def is_admin(email) -> bool`.
3. Cookie value: `f"{email}|{expiry}|{hmac_sha256(f'{email}|{expiry}', secret)}"`, verified with
   `hmac.compare_digest` and an expiry check. 8 hours.
4. Tests, and they are the point of this task:
   - A tampered email fails.
   - A tampered expiry fails.
   - An expired-but-well-signed cookie fails.
   - A cookie signed with a different secret fails.
   - `enabled()` is False with either variable missing.

## Task B2: The queries

In `store.py`, and **selecting columns explicitly** — never `SELECT *`, so a future column is not
published by accident:

1. `admin_overview() -> dict` — counts by subscription status, plus signups in 7/30 days.
2. `admin_accounts(status=None, search=None, limit=50, offset=0) -> list[AdminRow]` — a frozen
   dataclass of email, created_at, plan, status, provider, current_period_end, device_count,
   last_seen. `LEFT JOIN` so accounts with no subscription appear.
3. `admin_account(account_id)` — one row plus its devices.
4. Tests: an account with no subscription appears with status `none`; search matches on a
   substring; the row type carries no hash or token field.

## Task B3: The routes

New `server/app/admin.py`, registered from `main.py` only when `admin_auth.enabled()`.

1. Every route returns **404** when the console is disabled — not 403. A disabled console should
   not advertise itself.
2. `GET /admin/signin`, `POST /admin/signin` — `store.authenticate`, then `is_admin`. A
   non-admin with correct credentials gets the same message as a wrong password, and both are
   rate-limited per IP.
3. `GET /admin` (overview), `GET /admin/accounts`, `GET /admin/accounts/{id}`,
   `POST /admin/signout`.
4. Render through the existing `layout()` from `pages.py`.
5. Cookie flags: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/admin`.
6. **No route writes to `subscriptions`.** Per spec B3, that is the one thing this must not be able
   to do.

## Task B4: CSV export

`GET /admin/accounts.csv`, same filters as the table, `text/csv` with a
`Content-Disposition: attachment`. Quote every field; an email is not a safe CSV cell by
assumption.

## Task B5: Route tests

1. Signed out ⇒ redirect to `/admin/signin`, for every route.
2. Non-admin account with valid credentials ⇒ refused.
3. Admin ⇒ 200, and the body contains a seeded account's email.
4. Console disabled ⇒ 404 on every route, including `/admin/signin`.
5. Rendered HTML **must not contain** any `password_hash` or `refresh_hash` value. Seed one with a
   recognisable sentinel and assert its absence.

## Task B6: Deploy

1. `.env.example`: `ADMIN_SESSION_SECRET`, `VERBALE_ADMIN_EMAILS`, both with a comment saying that
   empty disables the console.
2. `README.md`: how to generate the secret (`openssl rand -hex 32`) and turn the console on.
3. `deploy/nginx/verbale.conf`: `/admin` passes through like everything else. IP allowlisting is
   spec open-question 2 — decide at deploy.
4. Do **not** put real values in the repo.

## Task B7: Ship

1. Full suite green.
2. `deploy/deploy.sh`, then check `/healthz` and that `/admin` 404s until the two variables are set
   on the box.

---

## Definition of done

- `grep -ri razorpay server/` returns nothing but history.
- Deleting an account with a live Play subscription cancels it at Google, and refuses to delete if
  that fails.
- `/admin` lists every account and its subscription state, behind a signed cookie, and 404s when
  unconfigured.
- No admin route can grant entitlement.
- The trial is still invisible to the server, and the spec says so out loud.

---

## Outcome — 2026-09-02

Both parts landed. **216 server tests pass**, up from a 164-test baseline: 24 Razorpay tests went
with the code they covered, and 76 were added.

Three things the plan did not anticipate:

1. **`PlayError` carried only a message.** A1's contract needs "no such subscription" (404, settled)
   told apart from "could not reach Google" (transient), and the only way to do that was matching on
   the text of an error message. `PlayError` now carries `status`, set by both `_get` and `_post`.
   Without it the honest version of `cancel_play_subscription` could not have been written.
2. **`webhook_events` and `claim_event` were dead.** They existed solely for Razorpay's retry
   idempotency; Play is pulled, so nothing claims an event. The table is dropped in the v2
   migration, with a test asserting nothing else went with it.
3. **`test_account_deletion.py` patched `pages.cancel_subscription` by name.** Renaming the symbol
   without updating the fixture would have left the tests patching nothing and reaching the network
   — flagged in A0 and handled in the same commit.

Both guards were mutation-tested rather than assumed:

* Making `cancel_play_subscription` treat an unknown failure as success failed exactly the two
  tests written for it.
* Making the admin console trust any request failed exactly the three session tests.

Task A0 was found to be already satisfied by existing tests and was not rewritten.
