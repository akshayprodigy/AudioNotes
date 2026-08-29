# Licence server

Accounts, subscriptions and licence tokens for AudioNotes. Also the web pages where a
subscription is actually bought.

## What it deliberately does not do

It never receives a recording, a transcript, a title, or a count of anything a user made. The
app's claim is that recordings never leave the phone, and the way to keep a claim like that true
is to build a server with nowhere to put them. If a schema change here ever seems to need a
column describing a user's content, something has gone wrong upstream of the schema.

It is also the only place a subscription is sold. The Android app never links here — that is what
keeps the arrangement inside store policy — so these pages have to stand on their own for
somebody arriving from an email or a bookmark.

## Why not Play Billing

Play Billing only works for Play installs, and the app ships to other Android stores; a desktop
build cannot use it at all. One entitlement service is simpler than one-and-a-half, each with its
own refunds, dunning and reconciliation. The trade is that we own the subscription lifecycle,
which is what the webhook is.

## Running it

```bash
npm install
npm run keygen        # once, ever — see below
LICENCE_PRIVATE_KEY_PEM="$(cat key.pem)" npm run dev
```

| Variable | Needed for | Notes |
|---|---|---|
| `LICENCE_PRIVATE_KEY_PEM` | everything | Refuses to start without it |
| `DATABASE_PATH` | optional | Defaults to `licences.db` |
| `PORT` | optional | Defaults to 8787 |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | buying | Subscribe returns 503 without them |
| `RAZORPAY_PLAN_ID` | buying | The monthly plan created in the Razorpay dashboard |
| `RAZORPAY_WEBHOOK_SECRET` | renewals | Webhook returns 503 without it |

## The signing key

`npm run keygen` prints a P-256 pair and writes neither half to disk. The private half signs every
token and belongs only in the server's environment. The public half goes into
`android/gradle.properties` as `licencePublicKey`.

**Treat this key as permanent.** It is compiled into the app, so replacing it means every
installed copy rejects every token until it updates.

## The token

The contract with the app, in one line:

```
<base64url(payload)>.<base64url(SHA256withECDSA over the payload text)>
payload: v=1;sub=<account>;plan=<plan>;iat=<unix s>;exp=<unix s>;dev=<device id>
```

The other half lives in `android/.../billing/Licence.kt`. Neither side can change alone, and
`LicenceContractTest.kt` pins a token produced by this server's own `/api/account/signin` against
the verifier that ships — so a drift in signature encoding, field order or key format fails at
build time rather than on a customer's phone. Regenerate the fixture with
`scripts/contract-fixture.mjs`.

## Endpoints

| | |
|---|---|
| `POST /api/account/signup` | `{email, password}` |
| `POST /api/account/signin` | `{email, password, deviceId}` → licence token + a device-scoped refresh key |
| `POST /api/licence/refresh` | `{deviceId, refreshKey}` → a fresh token, no password |
| `POST /api/billing/subscribe` | Starts Razorpay checkout, returns the hosted URL |
| `POST /api/billing/webhook` | Razorpay events. The **only** thing that marks a subscription paid |
| `GET /healthz` | |

Pages: `/` (what it is and what Pro adds), `/signup`, `/account`.

## Decisions worth not re-litigating

**Tokens are verified offline, not checked live.** The remaining life of a token is the grace
period, so a subscriber on a plane keeps working and a bad afternoon here doesn't brick every
paying customer at once. It also means no call home on launch, which is what keeps the privacy
claim literally true.

**A token never outlives the paid period plus three days.** The grace exists because card renewals
fail for boring reasons — an expired card, a bank's fraud heuristic — and Razorpay retries over
the following days. Cutting someone off at the exact second their period ends punishes them for
their bank's behaviour, mid-meeting.

**Only the webhook may mark a subscription paid.** Never a redirect back from checkout: a browser
can be pointed anywhere by anyone.

**The paid-through date never moves backwards.** Webhook events can arrive out of order, and the
version that moves it back takes away time somebody has already paid for.

**Three devices per subscription.** "One subscription, all your devices" without a number becomes
one subscription and all your friends. A device already on the list always re-registers, so
reinstalling the app can never lock somebody out of their own subscription.

**Sign-in and refresh are separate credentials.** The password is typed once; the device keeps a
scoped refresh key. A refresh two weeks later shouldn't need the account password sitting on the
phone, or retyped by someone who has long since forgotten it.

## Not built yet

- Password reset.
- Gating the model download on entitlement, which is the real piracy barrier: the licence flag is
  a boolean someone can patch, whereas 1.1 GB of weights they have to source is not.
- Email: nothing is sent, so signup has no confirmation and there is no way to reach a customer.
