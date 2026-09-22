# What I need from you — 22 September 2026

Everything on the way to the Play Store that only you can do, in the order that unblocks the most.
Each point says what to do, and why. Tick them as you go; I am working through "Layer 1" on the
A07 in parallel and will not need you for that.

---

## A. Record the consent sentence in your voice

**What:** On any phone, in a quiet room, at a normal speaking pace, record exactly this sentence:

> "This meeting is being recorded by Verbale. The recording stays on this phone."

Any format is fine (voice memo, m4a, wav). Send me the file. About five seconds.

**Why:** The app says this out loud at the start of every recording so the recording itself proves
the room was told. Today it uses a robot voice, and the transcriber hears "Verbal". This is the last
piece of content missing from the build — the production build waits on it.

- [ ] Done

---

## B. Make one phone call to the A07 when I ask

**What:** When I say "now", call the A07's phone number from another phone. Let it ring, answer,
talk for about ten seconds, hang up. I will be recording on the A07 at the time.

**Why:** Proves a recording survives an incoming call and marks the gap correctly. Five minutes of
your time, and I cannot place a call to the phone from the Mac.

- [ ] Done

---

## C. Google Play Console — three things

**What:**

1. Create the app in Play Console: name **Verbale**, package name **`com.innocorelabs.verbale`**,
   app (not game), free. When it asks about signing, choose **Play App Signing** — this has to be
   chosen at creation; it cannot be added cleanly later.
2. Under *Monetise › Products › Subscriptions*, create **one** subscription:
   - Product ID: **`verbale_pro`** (exactly this — the app is built with this id)
   - Base plan 1, ID **`monthly`**, renews monthly: **₹299** in India, **$4.99** everywhere else
     (let Play convert the other currencies from USD)
   - Base plan 2, ID **`annual`**, renews yearly: **₹2,499** in India, **$39.99** everywhere else
3. Tell me the **Google account email** you will test purchases with. It goes on the licence-tester
   list so you can buy with test money.

**Why:** Nothing in the app can be bought until the product exists. Every "not ready" verdict since
14 September has been this one thing. The app shows the price Play sends, so the prices are set
here and nowhere else.

- [ ] App created, Play App Signing on
- [ ] `verbale_pro` with `monthly` and `annual`
- [ ] Tester email sent to me

---

## D. A Google Cloud service account (so purchases become licences)

**What:**

1. Go to **console.cloud.google.com**. Use the same Google account as the Play Console. Create a
   project (or use an existing one), for example "Verbale".
2. *APIs & Services › Library* → search **"Google Play Android Developer API"** → **Enable**.
3. *IAM & Admin › Service Accounts* → **Create service account**. Name it "verbale-licence".
   Skip the optional role steps. After it is created, open it → *Keys* → **Add key › Create new
   key › JSON**. A `.json` file downloads. **Send me that file** (it is a secret — WhatsApp or
   email to me is fine, do not commit it anywhere).
4. Back in **Play Console** → *Users and permissions* → **Invite new users** → paste the service
   account's email (it looks like `verbale-licence@…iam.gserviceaccount.com`) → under *App
   permissions* pick Verbale → under *Account permissions* tick **"Manage orders and
   subscriptions"** → Invite.

**Why:** When someone buys Pro, the app hands the purchase to your server, and the server asks
Google "is this real?" before it issues a licence. Today the server has no way to ask — I checked
the live server this morning and it answers "Play Billing is not configured". In that state a buyer
pays and gets nothing. The JSON file is the server's key to ask Google.

- [ ] JSON file sent to me
- [ ] Service account invited in Play Console with "Manage orders and subscriptions"

---

## E. Say "yes" to two small changes on your server

**What:** Reply "yes to E" and I will do both:

1. Put the JSON from D on the server and restart it (one minute).
2. Re-run the model mirror script so the 37 MB "meaning index" downloads from your server instead
   of Hugging Face (a few minutes; nothing else changes).

**Why:** Both touch the live server, so I do not do them without your word.

- [ ] Yes to E

---

## F. Borrow a Xiaomi / Redmi / Poco or Realme phone for one day

**What:** Any Redmi, Poco, Xiaomi or Realme phone from the last four years, unlocked, with USB
debugging turned on (I can talk you through that in two minutes). Plug it into the Mac next to the
A07. I install the app, run one meeting, and remove it afterwards.

**Why:** Those brands (MIUI / HyperOS / ColorOS) kill background work far more aggressively than
Samsung or Google. The app has never run on one. A meeting that dies mid-recording there is a user
who never gets their notes and never comes back. Testing on cheap phones is what found six real
bugs already.

- [ ] Phone arranged

---

## G. One decision: the older-chip phones

**What:** Phones with older processors — Redmi 9, Redmi 9A, Redmi Note 9, Realme C-series, most
phones with a Helio G25/G35/G80/G85 or Snapdragon 4xx/636/660 chip — cannot run the speech engines
as built. Today the app tells them so, politely, at first run, and refuses. A second, slower build
of the engine would let them run, at roughly half speed.

Decide: **(a) launch with the refusal** and add the slow build later, or **(b) build it before
launch**. If (b), I also need one such phone for a day, like F.

**Why:** It is a real slice of the Indian market, and it is the slowest piece of work on this list —
so it should be your call, not mine.

- [ ] Decision: (a) or (b)

---

## H. Leave the A07 plugged in and on Wi-Fi

**What:** Nothing to do — just do not unplug it. Its data is disposable; I will tell you before any
wipe.

**Why:** I am running the remaining by-hand checks on it, and later a 90-minute recording with
audio played from the Mac.

---

## I. Later, not now: the store listing and the rollout

**What:** When the build is ready I will hand you screenshots from the A07, two short screen
recordings Google asks for (the recording notification and the processing notification), and the
listing text — all in `docs/play-console.md`. You upload them, fill in the Data safety form from the
table in that file, and set the first rollout to **5–10 %**.

**Why:** Only the account owner can upload. A small first rollout means a bad build is recoverable.

- [ ] Listing uploaded
- [ ] Rollout set to 5–10 %

---

**If you do only two things today, do A and C.** Then D. Everything else can follow.
