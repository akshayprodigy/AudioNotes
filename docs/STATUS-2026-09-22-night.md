# Verbale — where things stand, 22 September 2026, night

*The current document. It supersedes `docs/FOUNDER_TODO_2026-09-22.md` and every earlier list;
if two documents disagree, this one is right. Written after the Layer 1 cleanup was built,
reviewed and device-verified, and after your consent clip went into the build.*

*Updated 23:30 with the store screenshots, two defects the screenshot run found, and one
diarization finding. §3 and §6 are the new parts.*

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
| 1 | **Play Store screenshots, ASO-ready.** Eight of them, in `docs/store/screenshots/`, numbered in listing order and ready to upload. Captured on a Pixel 9 emulator as you asked, then composed onto 1080×1920 frames with headlines — a raw emulator capture is 1 : 2.24 and Play rejects anything past 1 : 2. `docs/store/README.md` says what each one is and how to rebuild them. | **done** |
| 2 | **The AAB**, version 1.0.0, rebuilt tonight with the two fixes below: `android/app/build/outputs/bundle/release/app-release.aab`, 43 MB, signed. Gate green against it. | **done** |
| 3 | **The two foreground-service videos** Play asks for, one per declared type: `docs/store/videos/`, about forty seconds each, single take. The microphone one shows a recording still counting in the picture-in-picture control and the notification after you leave the app; the dataSync one shows the stages running from the launcher through to "Your notes are ready". | **done** |
| 4 | **The feature graphic**, 1024×500: `docs/store/feature-graphic.png`. | **done** |
| 5 | **The 90-minute capture**, once you have run it — I read the numbers off the phone and write them up, starting with the speaker count (§6). | waits for you, tomorrow |
| 6 | **Your server**, the moment you say "yes": the service-account JSON on the box, and the model mirror re-run so the meaning index stops falling back to Hugging Face. | waits for you |

**Every store asset Play asks for now exists** — eight screenshots, the feature graphic and both
videos, all in `docs/store/`, with `docs/store/README.md` saying what each is. The listing text and
the Data safety table are already in `docs/play-console.md`. Nothing on the listing is waiting on
me.

Both videos were shot on the emulator, whose microphone records silence. They demonstrate the
service behaviour, which is what review asks for; if review pushes back, sixty seconds on the A07
in a real room is the better answer and the scripts run unattended against a device serial.

### Two defects the screenshot run found, both fixed (`7eda0fc`)

Driving the app for the captures put it through screens no test had watched on a real display.

- **The Ask composer was hidden behind the keyboard.** You typed your question blind. Its
  keyboard-avoiding view trusted the activity's `adjustResize`, which under the edge-to-edge
  window an app targeting SDK 35 gets no longer resizes anything — the keyboard took the bottom
  883px while the input stayed put. Same one-word fix the Rename card already carries.
- **The running stage's label was clipped.** *"Written up in plain English · 13 of 17"* lost its
  "7" off the edge of the card. **This one was about to matter to you:** a ninety-minute meeting
  counts into three digits, so tomorrow's capture would have shown it worse.

Both have a test, and both tests were checked against their mutant. Gate: 614 JS tests, plus
scans, mutations, Kotlin and the 30 C++ tests — all clear.

> **The A07 was unplugged when I built this, so it still has the older build.** Plug it in before
> you start tomorrow and say so — reinstalling takes two minutes and keeps the models and
> permissions. If you would rather not, the capture still works; you will just see that clipped
> label on the progress screen.

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

**117 commits** sit on `main` locally, against `origin/main` at `5ff0f5b`. You push.

*(An earlier draft of this note said 35. That was wrong — `git rev-list --count origin/main..HEAD` says 114. Nothing about the work changed; the count did.)*

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

## 6. One open finding: diarization put three voices in one bucket

Building the screenshots needed a multi-speaker meeting, so I made one — fourteen turns, three
different synthetic voices (US female, UK male, AU female), real pauses between them. The app
segmented it perfectly: **14 segments for 14 turns.** Then it labelled every one of them
*Speaker 1*.

I do not yet know which of these it is, and I did not guess at it tonight:

- **The audio.** Three voices out of one synthesiser have no room, no microphone and no channel
  difference — exactly the things a speaker-embedding model leans on. Synthetic audio may simply
  be a bad test.
- **The threshold.** Auto-clustering merges below a distance of `1.0` (`cpp/diar/diarizer.h`;
  "smaller splits more"). Android and the offline harness use the same value, so there is no
  divergence — but the harness measured **DER 48.8%** on real AMI meetings, and over-merging is
  the classic cause of a number that size.

**What settles it is your capture tomorrow** — a real room, real microphone, real voices. I will
read the speaker count off it first thing. If real speakers come out separate, this was my test
file. If they do not, the threshold is a tuning job with an existing harness (`eval/`) to measure
it, and it is a day's work, not a rewrite.

**Nothing was changed on the strength of one synthetic file**, and the store screenshots make no
"who said what" claim — that slot went to Ask instead.

---

*Next document supersedes this one. If you are reading anything dated earlier, close it.*
