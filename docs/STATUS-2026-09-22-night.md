# Verbale — where things stand, 22 September 2026, night

*The current document. It supersedes `docs/FOUNDER_TODO_2026-09-22.md` and every earlier list;
if two documents disagree, this one is right. Written after the Layer 1 cleanup was built,
reviewed and device-verified, and after your consent clip went into the build.*

---

## 1. What changed today

| | |
|---|---|
| **The consent clip is in.** | Your ElevenLabs render replaced the synthesised placeholder that has shipped since 6 September. Converted to the format the asset has always had (16 kHz mono PCM16) and brought up 1.20× so the loudness margins measured on a real room still hold. **Verified on the A07 tonight:** `heard=true found=true peak/bg=9.80 loudness=4.22 lag=420ms` — the placeholder measured 2.35 loudness on 6 September, so your clip is nearly twice as clear to the verifier — and the log confirms `announcement at 420ms kept out of ASR`. The meeting it was recorded in auto-titled itself from what was *said*, not from the clip. **This was the last piece of content the build was waiting for.** |
| **Nine defects fixed, reviewed and device-verified** | The Layer 1 cleanup: the schedule-change decision cue, a three-word floor on questions, inline section labels, Android's six-hour service limit, and five screen defects. Report: `docs/superpowers/reports/2026-09-22-layer-1-cleanup.md`. |
| **The review caught what the tests could not** | The new "a date that moved is a decision" rule fired in every test and **never on a real meeting**: whisper hears *"Shipping **move** to Thursday"*, not "moved". Widened and re-proved on the phone. |
| **Every remaining Layer 1 item is now closed except the 90-minute capture** | The last two were proved tonight on a fresh install: the paywall scrolls back to its answer when the trial starts, and the first-run download path works end to end (96 MB from your mirror, under a minute). |
| **Version is 1.0.0** | Your call. The uncommitted 0.9.0 change is reverted; the tree is clean. |

---

## 2. The phone is ready for your 90-minute capture

The A07 is wiped and set up so you can start in the morning without touching anything:

- Clean install of the current build (1.0.0, with your clip), **Free tier**, no meetings.
- Models downloaded, microphone and notification permissions already granted, **battery
  optimisation exemption already on** — that last one matters for a ninety-minute recording.
- Left on the Meetings screen. **Tap Record, and if it shows the one-time "Before you record"
  card, tap "Everyone's in — let's go".**

**It is deliberately on Free, not the trial.** On Pro, a 90-minute meeting would queue roughly six
hours of narration behind the capture and tie the phone up all day. On Free it is capture → VAD →
ASR → diarization → rule minutes, about seventy minutes of work after you stop, which is the thing
this test is actually for: disk growth, the wake lock, and whether the service survives.

---

## 3. Mine — what I am doing next, in order

| | What | State |
|---|---|---|
| 1 | **Play Store screenshots, ASO-ready** — captured on a Pixel 9 emulator at 1080×2424 as you asked, then composed onto 9:16 frames with headlines. (Raw emulator shots are 1 : 2.24 and Play rejects anything past 1 : 2, so they have to be composed rather than uploaded as-is.) | in progress tonight |
| 2 | **The two screen recordings** Google asks for — the recording notification and the processing notification. | after the shots |
| 3 | **The 90-minute capture**, once you have run it — I read the numbers off the phone and write them up. | waits for you, tomorrow |
| 4 | **Build the AAB** and re-run the full gate against it. | after 3 |
| 5 | **Your server**, the moment you say "yes": the service-account JSON on the box, and the model mirror re-run so the meaning index stops falling back to Hugging Face. | waits for you |

---

## 4. Yours — and points 1 and 2 are the whole remaining blocker

### 1. Play Console — and I think I know why you are stuck

**Google will not let you create a subscription until the app has a build on a track.** That is
almost certainly the wall you hit: *Monetise › Products › Subscriptions* stays closed until an
AAB has been uploaded, even to a closed or internal track. So the order has to be:

1. **Create the app** — name **Verbale**, package **`com.innocorelabs.verbale`**, app (not game),
   free. Choose **Play App Signing** when asked; it cannot be added cleanly later.
2. **Tell me**, and I hand you the AAB (I can have it ready within the hour of your word).
3. **Upload it to Internal testing** and roll that track out to yourself. Nothing is public.
4. **Now** *Monetise › Products › Subscriptions* opens. Create **one** subscription:
   - Product ID **`verbale_pro`** — exactly this, the app is built with it
   - Base plan **`monthly`**: **₹299** India, **$4.99** elsewhere
   - Base plan **`annual`**: **₹2,499** India, **$39.99** elsewhere
5. Send me the **Google account email** you will test purchases with.

If you are stuck somewhere other than step 4, tell me which screen and what it says and I will
work out the rest.

- [ ] App created, Play App Signing on
- [ ] AAB uploaded to Internal testing
- [ ] `verbale_pro` with `monthly` and `annual`
- [ ] Tester email sent to me

### 2. The Google Cloud service account

1. **console.cloud.google.com**, same Google account. New project, e.g. "Verbale".
2. *APIs & Services › Library* → **"Google Play Android Developer API"** → **Enable**.
3. *IAM & Admin › Service Accounts* → **Create service account**, name it "verbale-licence", skip
   the optional roles → open it → *Keys* → **Add key › Create new key › JSON**. **Send me that
   file.** It is a secret; it is never committed anywhere.
4. **Play Console** → *Users and permissions* → **Invite new users** → paste the service account's
   email → *App permissions*: Verbale → *Account permissions*: **"Manage orders and
   subscriptions"** → Invite.

**Why it cannot wait:** the live server answers *"Play Billing is not configured"* today, and on
that answer the app acknowledges the purchase and stores no licence. **A buyer would pay and get
nothing.** This JSON is the only thing standing between those two states.

- [ ] JSON sent to me
- [ ] Service account invited with "Manage orders and subscriptions"

### 3. Say "yes to 3"

Then I put the JSON on the server, restart it, and re-run the model mirror. Both touch the live
box, so I do not do them without your word.

- [ ] Yes to 3

### 4. The 90-minute capture — tomorrow morning

Tap Record, leave it running for ninety minutes (any audio, or none — a silent room is a weaker
test but still tells us about the service), then Stop and leave the phone plugged in. Tell me when
it is done and I will read the numbers off it.

- [ ] Done

### 5. One phone call, when I ask

Call the A07 from another phone while I am recording, talk for ten seconds, hang up. Proves a
recording survives an incoming call.

- [ ] Done

### 6. A Redmi / Poco / Xiaomi / Realme for one day

MIUI, HyperOS and ColorOS kill background work far harder than Samsung. The app has never run on
one, and background processing is what the whole product depends on.

- [ ] Phone arranged

### 7. The older-chip decision

Phones on Helio G25–G85 and Snapdragon 4xx/636/660 cannot run the engines as built; today the app
tells them so and refuses. A second, slower build would let them run at about half speed.
**(a) launch with the refusal**, or **(b) build it first**? If (b), I need one such phone for a day.

- [ ] (a) or (b)

### 8. Push

**35 commits** sit on `main` locally. You push.

- [ ] Pushed

### 9. Last: the listing and the rollout

I hand you the screenshots, the two recordings, the listing text and the Data safety table
(`docs/play-console.md`); you upload and set the first rollout to **5–10%**.

- [ ] Listing uploaded
- [ ] Rollout at 5–10%

---

## 5. The honest state of the product

**Everything the app does is built, and every feature in the 7 September improvement report is
either shipped, deliberately rejected, or listed above.** Three phones have been through it end to
end — a Pixel 7 Pro (now dead), a 32-bit Galaxy Tab A, and the Galaxy A07 that has found nine real
bugs on its own.

**What is not proven:** that anybody can buy it. No `verbale_pro` product exists, so no paywall on
any phone has ever shown a real price, and no purchase has ever completed. That is not a code
problem and I cannot fix it from here — it is points 1 and 2 above.

**What is not tested:** a MIUI or ColorOS phone, an older-chip phone, a ninety-minute capture, and
an incoming call mid-recording.

---

*Next document supersedes this one. If you are reading anything dated earlier, close it.*
