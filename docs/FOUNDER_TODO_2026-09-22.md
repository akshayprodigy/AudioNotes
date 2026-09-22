# What I need from you — the final list

*Rewritten the night of 22 September 2026, after the Layer 1 cleanup was built, reviewed and
device-verified. This supersedes the morning version of this file. Everything the app itself
needs is now done except one build step; what is below is the part only you can do.*

**Point A is closed** — you made the consent clip and I found it
(`~/Downloads/ElevenLabs_2026-09-22T11_02_31_…mp3`). Whisper reads it back as *"This meeting is
being recorded by Verbali. The recording stays on this phone."* I am landing it in the build; no
further action from you.

---

## 1. Google Play Console — three things *(the one real blocker)*

**What:**

1. Create the app: name **Verbale**, package **`com.innocorelabs.verbale`**, app (not game), free.
   When it asks about signing, choose **Play App Signing** — it has to be chosen at creation.
2. *Monetise › Products › Subscriptions* → **one** subscription:
   - Product ID **`verbale_pro`** (exactly this — the app is built with this id)
   - Base plan **`monthly`**: **₹299** in India, **$4.99** elsewhere
   - Base plan **`annual`**: **₹2,499** in India, **$39.99** elsewhere
3. Tell me the **Google account email** you will test purchases with, for the licence-tester list.

**Why:** nothing in the app can be bought until the product exists. Every "not ready" verdict since
14 September has been this one thing. The app shows whatever price Play sends, so the prices live
here and nowhere else.

- [ ] App created, Play App Signing on
- [ ] `verbale_pro` with `monthly` and `annual`
- [ ] Tester email sent to me

---

## 2. A Google Cloud service account *(so a purchase becomes a licence)*

**What:**

1. **console.cloud.google.com**, same Google account as Play Console. Create a project, e.g.
   "Verbale".
2. *APIs & Services › Library* → **"Google Play Android Developer API"** → **Enable**.
3. *IAM & Admin › Service Accounts* → **Create service account**, name it "verbale-licence", skip
   the optional roles. Open it → *Keys* → **Add key › Create new key › JSON**. **Send me that
   file** — it is a secret; WhatsApp or email is fine, it is never committed anywhere.
4. Back in **Play Console** → *Users and permissions* → **Invite new users** → paste the service
   account's email (`verbale-licence@….iam.gserviceaccount.com`) → *App permissions*: Verbale →
   *Account permissions*: tick **"Manage orders and subscriptions"** → Invite.

**Why:** when somebody buys Pro, the app hands the purchase to your server and the server asks
Google "is this real?" before issuing a licence. Today the live server answers *"Play Billing is
not configured"* — in that state **a buyer pays and gets nothing**. This JSON is the server's key
to ask.

- [ ] JSON file sent to me
- [ ] Service account invited with "Manage orders and subscriptions"

---

## 3. Say "yes" to two changes on your server

**What:** reply **"yes to 3"** and I do both:

1. Put the JSON from point 2 on the server and restart it (one minute).
2. Re-run the model mirror so the 37 MB meaning index downloads from your server instead of
   Hugging Face (a few minutes; nothing else changes).

**Why:** both touch the live server, so I do not do them without your word.

- [ ] Yes to 3

---

## 4. One decision: the version number

**What:** the tree carries an uncommitted change to `android/app/build.gradle` dropping
`appVersionName` from **1.0.0** to **0.9.0** (which makes the versionCode 10000 → 900). Tell me
which you want. I have left it exactly as you made it and built around it.

**Why:** it is the number Play remembers forever. A first upload at 900 means every later build
must be above 900, and "0.9.0" on a store listing says beta to a reader. Decide it on purpose
rather than letting whichever state the file is in at build time decide it.

- [ ] 1.0.0 (what is committed) — or — [ ] 0.9.0 (your uncommitted change)

---

## 5. One phone call, when I ask

**What:** when I say "now", call the A07 from another phone, let it ring, answer, talk for about
ten seconds, hang up. I will be recording at the time.

**Why:** proves a recording survives an incoming call and marks the gap. Five minutes, and I
cannot place a call to the phone from the Mac.

- [ ] Done

---

## 6. Borrow a Xiaomi / Redmi / Poco or Realme phone for a day

**What:** any of those from the last four years, unlocked, USB debugging on (two minutes, I can
talk you through it). Plug it in next to the A07. I install, run one meeting, remove it after.

**Why:** MIUI / HyperOS / ColorOS kill background work far more aggressively than Samsung or
Google, and the app has never run on one. A meeting that dies mid-recording there is a user who
never gets their notes. Cheap phones have found nine real bugs so far.

- [ ] Phone arranged

---

## 7. One decision: the older-chip phones

**What:** phones with older processors — Redmi 9/9A/Note 9, Realme C-series, most Helio
G25/G35/G80/G85 and Snapdragon 4xx/636/660 — cannot run the speech engines as built. Today the app
tells them so at first run and refuses. A second, slower build of the engine would let them run at
roughly half speed.

Decide: **(a) launch with the refusal** and add the slow build later, or **(b) build it before
launch**. If (b), I also need one such phone for a day.

**Why:** a real slice of the Indian market, and the slowest piece of work left — so it is your
call, not mine.

- [ ] (a) or (b)

---

## 8. Push, when you are ready

**What:** 33 commits sit on `main` locally, unpushed. You push.

**Why:** your rule, and it has been right — several of those commits were rewritten after the
phone disagreed with them.

- [ ] Pushed

---

## 9. Last, once I hand you the build

**What:** the store listing (screenshots and two short screen recordings I will give you, plus the
text and the Data safety table in `docs/play-console.md`), then the first rollout at **5–10%**.

**Why:** only the account owner can upload, and a small first rollout makes a bad build
recoverable.

- [ ] Listing uploaded
- [ ] Rollout at 5–10%

---

**If you do only one thing, do point 1.** Then 2, then reply "yes to 3". Points 1–3 are the entire
reason the app cannot be sold today; everything else on this list can follow the launch.
