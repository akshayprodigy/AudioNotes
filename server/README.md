# Licence server

Accounts, subscriptions and licence tokens for Verbale. Also the web pages where a subscription
is actually bought.

Python, FastAPI, SQLite. One container on a localhost port, with the host's nginx in front.

## What it deliberately does not do

It never receives a recording, a transcript, a title, or a count of anything a user made. The app's
claim is that recordings never leave the phone, and the way to keep a claim like that true is to
build a server with nowhere to put them. If a schema change here ever seems to need a column
describing a user's content, something has gone wrong upstream of the schema.

It is also the only place a subscription is sold. The Android app never links here — that is what
keeps the arrangement inside store policy — so these pages have to stand on their own for somebody
arriving from an email or a bookmark.

## Two ways to pay, one entitlement

Play Billing for Play installs; Razorpay on the web for every other Android store and, later, for
desktop. Both end in the same `subscriptions` row and the same licence token, because entitlement
is one concept and keeping two of it is how somebody ends up paying twice or losing access on the
wrong device.

Play Billing alone would not do: it cannot serve other Android stores and a desktop build cannot
use it at all. Razorpay alone is the arrangement Play is most likely to take exception to from a
developer with no track record — the design is legitimate (the app shows no price and links to no
checkout) but it rests on a reviewer's judgement, and the downside is the account rather than the
commission.

They differ in one structural way. Razorpay **pushes**: a signed webhook is the only thing that may
mark a subscription paid. Play **pulls**: the purchase token is re-verified against Google on every
licence refresh, which is what makes real-time notifications, a Pub/Sub topic and another service
to keep alive unnecessary. The app refreshes about weekly and a token lasts a fortnight, so the
worst case is a cancelled subscriber keeping Pro slightly longer — the right direction to err in.

A Play purchase creates an account with **no email and no password**. Google has already
established who the person is, and making them invent a password to receive what they just paid
for is friction that buys nothing. They can add an email later to use the same subscription on a
desktop.

## Running it locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m app.keygen          # once, ever — see below
LICENCE_PRIVATE_KEY_PEM="$(cat key.pem)" \
  .venv/bin/python -m uvicorn app.main:create_app --factory --reload --port 8787
.venv/bin/python -m pytest              # 87 tests
```

Or the real thing, exactly as it runs in production:

```bash
cp .env.example .env    # fill in LICENCE_PRIVATE_KEY_PEM
docker compose up --build
```

| Variable | Needed for | Notes |
|---|---|---|
| `LICENCE_PRIVATE_KEY_PEM` | everything | The server refuses to boot without it |
| `BIND_ADDRESS` / `HOST_PORT` | exposure | `127.0.0.1:9100`. nginx is the only thing that should reach it |
| `DATABASE_PATH` | optional | `/data/licences.db` in the container |
| `PORT` | optional | Defaults to 8787 |
| `SMTP_HOST` / `SMTP_FROM` (+ `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`) | password reset | Unconfigured, the mail is logged instead of sent |
| `PUBLIC_BASE_URL` | emailed links | Without it, links are built from the request's Host header |
| `PLAY_SERVICE_ACCOUNT_JSON` / `PLAY_PACKAGE_NAME` | Play purchases | The link endpoint answers 503 without them |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | buying on the web | Subscribe answers 503 without them |
| `RAZORPAY_PLAN_ID` | buying | The monthly plan created in the Razorpay dashboard |
| `RAZORPAY_WEBHOOK_SECRET` | renewals | The webhook answers 503 without it |

Everything except the signing key is optional, and the server is useful without any of them: the
free tier, sign-in and the web pages all work with billing unconfigured.

## Deploying

```bash
VERBALE_HOST=root@your.server ./deploy/deploy.sh
```

rsync, then `docker compose up -d --build`, then wait for health. It never transfers `.env` or a
database, so secrets and accounts live on the server and survive every deploy.

### First run on a new host

```bash
ssh root@your.server 'mkdir -p /opt/verbale'
scp .env.example root@your.server:/opt/verbale/.env
ssh root@your.server 'vi /opt/verbale/.env'    # paste the signing key
VERBALE_HOST=root@your.server ./deploy/deploy.sh
```

### Putting it on a hostname

The container publishes on `127.0.0.1:9100` and nothing else can reach it. To serve it publicly,
point an A record at the host and then, **on the server**:

```bash
cd /opt/verbale
VERBALE_HOSTNAME=verbale.innocorelabs.com ./deploy/setup-nginx.sh
```

That obtains a certificate, installs the nginx site and reloads. It refuses to start if DNS does
not point here yet, because a failed challenge spends one of Let's Encrypt's five-per-week
attempts on that name.

**Why nginx and not a proxy in this compose file.** The host already runs nginx on 80/443 in front
of several other projects, each a container on a localhost port. A second proxy competing for
those ports would take all of them down. `nginx -t` in the setup script validates every site on
the machine, not only this one, before anything is reloaded.

### The model mirror

This host also serves the ~1.4 GB of model weights the app downloads on first run, at
`/models/v1/`. Fill it — **from the server**, which pulls the files from GitHub and Hugging Face
itself rather than having 1.4 GB pushed up from a laptop:

```bash
VERBALE_HOST=root@69.62.82.85 ./deploy/mirror-models.sh
./scripts/mirror-models.py verify --base https://verbale.innocorelabs.com   # from anywhere
```

Idempotent: a file already present with the right sha256 is skipped, so a re-run after a failure
resumes rather than restarts.

**Why here and not an object store.** The obvious answer is Cloudflare R2, whose egress is free,
and it may still be the answer later — but this box is in Mumbai, which is where the users this
app is built for actually are; it has 184 GB spare and had moved 3.5 GB in its first eighteen
weeks; and a launch that depends on one fewer account and one fewer bill is worth something real.
The bandwidth arithmetic is roughly 114 MB per install, plus 1.2 GB for each user who takes the
writer model — about 230 GB per thousand installs at a 10% attach rate. Check the plan's monthly
allowance against that before it matters, and if it ever does, `modelBaseUrl` is one gradle
property and `mirror-models.py fetch` already lays the files out the way an object store wants.

**Files live in `/srv/verbale-models`, not `/opt/verbale`.** `deploy.sh` rsyncs with `--delete`, so
a mirror kept under the app directory would be erased by the next unrelated deploy — and first run
would quietly fall back to upstream with nobody the wiser.

**What the nginx block is doing.** Bandwidth is capped per connection and, separately, across the
whole mirror, because the licence API shares this machine and a phone pulling 1.1 GB of weights
must never be why someone else's sign-in times out. Exceeding the global cap returns 503, which is
the *good* outcome: `ModelManagerModule.fetchTo` treats any non-2xx as "this source failed" and
falls through to the upstream URL, so a saturated mirror degrades to a slower download instead of
an error. That fallback is what makes it safe to set the cap low enough to actually protect the
API. `gzip off` is load-bearing too — gzip silently disables byte-range replies, and the
downloader resumes a broken 1.1 GB transfer with `Range: bytes=N-`.

**It closes a real hole, not just a dependency.** `silero-vad` was fetched from a `raw/master`
URL — a branch pointer. The day upstream committed a new model there, the sha256 check would fail
and first run would break for *new installs only*, so nothing in crash reporting would fire and
nobody already running the app would notice. It would surface as store reviews. Serving our own
copy first means an upstream change can no longer break anyone. Run `./scripts/mirror-models.py
check` occasionally anyway, to know when the catalog has drifted from upstream.

It also means first run stops announcing itself to GitHub and Hugging Face. For an app whose whole
promise is that nothing leaves your phone, having every install introduce itself to two third
parties was a wart.

### Backups

```bash
VERBALE_HOST=root@your.server ./deploy/backup.sh
```

Everything the server knows is one SQLite file, so this is the whole disaster plan. It uses
sqlite3's `.backup` rather than `cp`, because copying a file mid-write with WAL on produces
something that looks like a database and is not, and it refuses to keep a download that fails
`integrity_check` — a truncated backup is worse than none, because it looks like one.

## The signing key

`python -m app.keygen` prints a P-256 pair and writes neither half to disk. The private half signs
every token and belongs only in the server's environment. The public half goes into
`android/gradle.properties` as `licencePublicKey`.

**Treat this key as permanent.** It is compiled into the app, so replacing it means every installed
copy rejects every token until it updates.

## The token

The contract with the app, in one line:

```
<base64url(payload)>.<base64url(SHA256withECDSA over the payload text)>
payload: v=1;sub=<account>;plan=<plan>;iat=<unix s>;exp=<unix s>;dev=<device id>
```

The other half lives in `android/.../billing/Licence.kt`. Neither side can change alone, and
`LicenceContractTest.kt` pins a token this server minted — over a real socket, through
`/api/account/signin` — against the verifier that ships. So a drift in signature encoding, field
order or key format fails at build time rather than on a customer's phone.

That test is the only thing in the system that observes Python and Kotlin agreeing. Regenerate its
fixture with `python scripts/contract_fixture.py`, and expect to re-run
`./gradlew :app:testDebugUnitTest` when you do.

## Endpoints

| | |
|---|---|
| `POST /api/account/signup` | `{email, password}` |
| `POST /api/account/signin` | `{email, password, deviceId}` → licence token + a device-scoped refresh key |
| `POST /api/licence/refresh` | `{deviceId, refreshKey}` → a fresh token, no password |
| `POST /api/billing/play/link` | `{purchaseToken, deviceId}` → licence token. Play's equivalent of signing in |
| `POST /api/billing/subscribe` | Starts Razorpay checkout, returns the hosted URL |
| `POST /api/billing/webhook` | Razorpay events. The **only** thing that marks a subscription paid |
| `GET /healthz` | |

Pages: `/` (what it is and what Pro adds), `/signup`, `/account`, `/forgot`, `/reset`, `/privacy`,
`/terms`, and the `/subscribe`, `/devices/forget` and `/account/delete` actions they post to.

There is no `/docs`: six endpoints are documented above, and a generated explorer is only an
invitation to poke at the billing routes.

## Decisions worth not re-litigating

**Tokens are verified offline, not checked live.** The remaining life of a token is the grace
period, so a subscriber on a plane keeps working and a bad afternoon here doesn't brick every
paying customer at once. It also means no call home on launch, which is what keeps the privacy
claim literally true.

**A token never outlives the paid period plus three days.** The grace exists because card renewals
fail for boring reasons — an expired card, a bank's fraud heuristic — and Razorpay retries over the
following days. Cutting someone off at the exact second their period ends punishes them for their
bank's behaviour, mid-meeting.

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

**The app is built by a factory, not a module-level `app`.** Loading the signing key inside
`create_app` means a server with no key dies at boot with one clear message instead of starting
happily and failing every request. Uvicorn is run with `--factory` for this reason.

**One SQLite connection behind one lock.** Uvicorn runs the sync handlers on a thread pool. At a
few requests a minute a global lock costs nothing and removes an entire class of interleaving bug;
`Store` is the only module that touches SQL, so Postgres later is one file.

## Password reset

`/forgot` emails a link; `/reset` spends it. Two rules shape the whole flow:

**The pages never reveal whether an address has an account.** `/forgot` returns byte-identical HTML
either way, and sends nothing when there is no account. Otherwise this page is a way to ask who has
registered here.

**A link is worth nothing once used or aged out.** Single-use, one hour, and asking again retires
the previous one — two live links means a request somebody did not make stays usable after one they
did. Opening the link does *not* spend it, because mail clients prefetch.

Resetting also clears every device's refresh key. A reset is the moment to evict whoever got in,
and changing the password alone does not do that: a device that already signed in holds a renewal
credential that is not derived from the password. The device rows survive, so nobody is pushed over
the limit by their own reset — they sign in again.

## Deleting an account

`/account/delete`, from the account page, with the password. Play requires an app with accounts to
offer this from the web, and it is correct anyway: an account somebody cannot get rid of is not
theirs.

The subscription is cancelled at Razorpay **first**, and a failure there stops the deletion. Our
row going away does not stop Razorpay charging the card — being billed monthly for an account you
deleted is the worst thing this system could do to somebody, so that path refuses rather than
logging and stepping over it.

Everything else cascades from the foreign keys, which is why `PRAGMA foreign_keys = ON` at connect
time is load-bearing and not tidiness.

## Privacy policy and terms

`/privacy` and `/terms`, in `legal.py`. **Drafts — not reviewed by a lawyer.** They are written to
be accurate about what this system does, which is the part an engineer can get right and a template
cannot: the list of what the server holds *is* the schema, and there is a test asserting the policy
still names what `store.py` actually stores.

The product name in them comes from `branding.py`, so the pending rename is one edit rather than a
search through prose.

## Schema changes

`user_version` and `_migrate` in store.py. `CREATE TABLE IF NOT EXISTS` is **not** a migration: on
a table that already exists with the wrong shape it silently does nothing, and the mismatch stays
invisible until a query hits the missing column — in production, on the payment path.

One trap worth knowing if you add one. `PRAGMA foreign_keys` is a no-op **inside a transaction**,
and a migration that rebuilds a table has to turn foreign keys off to do it (with them on, `DROP
TABLE accounts` fires ON DELETE CASCADE and takes every subscription and device with it). So the
pragma is re-asserted in `Store.__init__` after the commit, which is the only place it takes
effect. Getting this wrong leaves the connection with foreign keys off, and account deletion then
orphans rows instead of cascading — silently. There is a test for it.

## Not built yet

- Nothing blocking. The remaining work is configuration the server cannot supply itself: Razorpay
  live keys, SMTP credentials, and the DNS record that lets it serve a hostname over TLS.
