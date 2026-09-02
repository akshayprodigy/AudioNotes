# Play-only billing, and an admin console — design

**Status:** implemented 2026-09-02 — 216 server tests green
**Date:** 2026-09-02
**Supersedes:** the Razorpay half of `server/app/billing.py`

## Overview

Two changes to the licence server, taken together because they touch the same three files and the
second is much simpler once the first has landed.

1. **Razorpay comes out.** Purchasing is Google Play Billing, always. A second payment provider
   that nothing will ever call is not optionality, it is a second way for entitlement to be wrong.
2. **An admin console goes in.** Today there is no way to answer "who has subscribed?" without an
   ssh session and a hand-written SQL string. The data has always been recorded; nothing has been
   lost. What is missing is a way to look at it.

Neither is user-visible. Both are prerequisites for testing with real accounts, which is what the
product is waiting on.

## The product frame

The app ships through Google Play, and purchases happen through Play Billing inside the app. There
is no web checkout, no desktop build today, and no second store. One provider is not a simplifying
assumption imposed on the design — it is the actual shape of the business.

## Goals

- One payment provider, one code path, no dead branches.
- A signed-in operator can see every account, its subscription state, and when it renews.
- Deleting an account still guarantees the card stops being charged.
- No customer PII leaves our own infrastructure.

## Non-goals

- Revenue reporting. Play Console owns money; this owns *who*.
- Trial visibility. See "What the console cannot show".
- Editing subscriptions from the browser. See B3.
- Any analytics SDK in the app.

---

# Part A — Razorpay comes out

## Why now

`server/app/billing.py` is 329 lines, of which roughly 160 are Razorpay: a lazily imported SDK, a
webhook with signature verification and idempotency, a status map, a subscription-start flow that
renders a checkout, and a cancel call. All of it is exercised only by its own tests.

The cost of keeping it is not the lines. It is that `subscriptions` rows carry a `provider`
discriminator, `is_entitled` reasons about states that arrive by two routes, and every future
change to entitlement has to be thought about twice. Removing it removes a whole axis.

## What must not break

### A1. Deleting an account must still stop the charging

`pages.py:483` cancels the subscription before deleting the account, and **refuses to delete when
the cancel fails**. The comment is right and the behaviour is right: erasing our row stops us
knowing about a subscription, it does not stop the money moving. Somebody billed monthly for an
account they deleted is the worst thing this system can do to a person.

Razorpay's `cancel_subscription` is what implements that guarantee today. It cannot simply be
deleted — the guard would be deleting accounts with live subscriptions behind it.

**Decision: implement the same guarantee against the Play Developer API.**

`purchases.subscriptions.cancel` needs the package name, the product id and the purchase token. We
store the purchase token as `provider_id`. We do **not** store the product id — but `play.verify()`
already returns it (`parse_subscription` reads `lineItems[0].productId`), so cancelling is
verify-then-cancel, and no schema change is needed.

Same contract as the function it replaces:

- Returns `(True, None)` when the subscription is cancelled **or was already** cancelled/expired —
  "already in the state we wanted" is success, and treating it as failure would strand the account
  forever.
- Returns `(False, message)` on anything else, and the caller refuses the deletion.

A subscription Google has never heard of (a token from a wiped test account) reports success: there
is no card to stop.

### A2. The `provider` column stays

Dropping a column in SQLite means rebuilding the table, and `_migrate` already carries a scar from
the last rebuild: with foreign keys on, `DROP TABLE accounts` fires `ON DELETE CASCADE` and takes
every subscription with it. That migration is written carefully and it is not worth writing a
second one to delete a column whose only cost is storing the same six characters on every row.

`provider` keeps its `NOT NULL DEFAULT`, changed from `'razorpay'` to `'play'`, and existing rows
are rewritten to `'play'` by a migration. `account_by_provider_id`'s default parameter changes to
match.

This is a deliberate retention of a column that will always hold one value. The alternative is a
destructive migration for cosmetics.

### A3. The grace window keeps its behaviour and loses its story

`PAYMENT_GRACE_SECONDS = 3 days` extends entitlement past `current_period_end` for `past_due`
subscriptions. Its docstring explains Razorpay's retry schedule.

With Play, `past_due` arrives from two states:

- `IN_GRACE_PERIOD` — Google is retrying, and `expiryTime` is still in the future, so the window is
  never reached.
- `ON_HOLD` — retries have failed and `expiryTime` has passed, so the window grants three extra
  days.

So the constant still does something, and what it does is defensible: three days of access to
somebody whose card failed, inside a hold Google may run for up to thirty. **Behaviour does not
change. The comment is rewritten to describe Play's states rather than Razorpay's**, because a
correct constant with a false explanation is how the next person makes a wrong change.

### A4. What is deleted

| Where | What |
|---|---|
| `billing.py` | `plan_id`, `_client`, `webhook_signature_matches`, `map_status`, `SubscribeResult`, `start_subscription`, `apply_webhook`, `cancel_subscription` |
| `main.py` | `POST /api/billing/subscribe`, `POST /api/billing/webhook` |
| `pages.py` | the web checkout page and its form |
| `store.py` | `'razorpay'` defaults |
| `legal.py` | Razorpay named as payment processor — **must** be corrected, it is a factual claim in the privacy policy |
| `requirements.txt` | the `razorpay` dependency |
| `.env.example`, `README.md`, `nginx/verbale.conf` | keys, webhook path |
| `deploy/seed-test-account.sh` | `provider='play'` |
| `tests/` | `test_billing.py`'s Razorpay half; Play tests stay |

`legal.py` is the one that matters beyond tidiness: a privacy policy naming a processor that
receives no data is a false statement to users.

---

# Part B — the admin console

## The question it answers

*Who has subscribed, when did they sign up, and what state is their subscription in?*

Everything needed is already stored: `accounts(email, created_at)`,
`subscriptions(plan, provider, status, current_period_end)`, `devices(first_seen, last_seen)`.

## B1. Authentication

The public pages carry **no sessions** — every action re-authenticates from the form, deliberately,
because there are two actions and no browsing to protect (`pages.py:219`).

A dashboard is different: it is browsing, across several pages, and it renders customer email
addresses. Re-posting a password per page is both worse UX and worse security, because it trains
the operator to type an admin password into a form repeatedly.

**Decision: a signed session cookie, scoped to the admin routes only.**

- Sign in with an existing account email and password, through `store.authenticate` — the same
  scrypt verification as everywhere else. No second credential store, no new password hashing.
- Authorisation is an allowlist: `VERBALE_ADMIN_EMAILS`, comma-separated, from the environment.
  Not a database column, so granting admin cannot be done by anything that can write the database,
  and an emptied variable locks the console rather than opening it.
- The cookie is `HMAC-SHA256(email + expiry)` under `ADMIN_SESSION_SECRET`, compared in constant
  time. `HttpOnly`, `Secure`, `SameSite=Strict`, 8-hour expiry, `Path=/admin`.
- **Unset `ADMIN_SESSION_SECRET` or empty `VERBALE_ADMIN_EMAILS` disables the console entirely** —
  every route 404s. A misconfigured deploy must not serve a customer list, and defaulting a secret
  is how that happens.
- Failed sign-ins are rate-limited per IP.

## B2. What it shows

- **Overview** — total accounts, active, past due, cancelled, never subscribed; signups in the last
  7 and 30 days.
- **Accounts** — email, signed up, plan, status, renews/expires, device count, last seen. Sortable,
  filterable by status, searchable by email. Paginated.
- **Account detail** — the same, plus that account's devices.
- **CSV export** of the accounts table.

Server-rendered through the existing `layout()`, like every other page here. No client framework
for four pages of tables.

## B3. Read-only, on purpose

The console will **not** have a "make this account Pro" button.

`billing.py` states the rule the whole design rests on: the only thing that may mark a subscription
paid is a verified purchase. An HTTP endpoint that can grant entitlement is exactly the thing that
must not exist, because it is reachable — by a session-fixation bug, a CSRF hole, a leaked cookie,
or an operator's stolen laptop. `deploy/seed-test-account.sh` stays as it is: something a person
runs on purpose, over ssh, with a comment explaining that it is the deliberate exception.

The trade is honest: granting a test account stays a terminal command rather than a click. That is
the correct side to err on for the one action that hands out the paid tier.

## B4. What it must never render

`password_hash`, `refresh_hash`, password-reset tokens, and licence tokens. The queries select
columns explicitly and never `SELECT *`, so a future column is not published by accident.

## What the console cannot show

**How many people are trialling.** The 7-day / 3-summary trial runs entirely on the device and is
enforced against a persisted monotonic clock in the app's own database. It never contacts the
server, by design — an offline app that phones home to count trials is not an offline app.

Making trials visible means the app reporting them, which is a product decision about the privacy
promise, not a dashboard feature. It is out of scope here and should be decided on its own merits.

---

## Rejected

**Firebase.** The subscription data lives in SQLite on our VPS; Firebase would know nothing about
it unless every write were mirrored, which is more work than this console and creates a second
source of truth about who has paid. Firebase Analytics answers "how many opened the app", a
different question. And it would put Google SDKs into an app whose entire claim is that nothing
leaves the phone — the website ships zero third-party requests on purpose.

**Keeping Razorpay "in case we need web checkout".** A payment path that is never exercised is a
payment path that does not work. If a desktop build ever needs one, it is written then, against
whatever the business actually is by then.

**Querying the database over ssh as the answer.** Fine as a stopgap on a pre-launch product; not a
system. It is unauditable, easy to get wrong, and gets copied into a shell history.

## Open questions

1. ~~**Play cancel scope.**~~ **Resolved.** `play.py` already requests
   `https://www.googleapis.com/auth/androidpublisher`, the full Android Publisher scope, which
   covers `purchases.subscriptions.cancel`. No scope change, and `_post` is already the right
   shape. What remains is operational, not code: the service account must hold the *Manage orders
   and subscriptions* permission in Play Console. If it does not, A1 falls back to refusing the
   deletion while a subscription is live and directing the user to cancel in Play — the guarantee
   is kept either way, only the ergonomics differ.
2. **IP-allowlisting `/admin` at nginx** as defence in depth. Cheap; blocks operator access from
   phones and cafés. Decide at deploy, not in code.
