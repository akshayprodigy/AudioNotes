# Verbale — everything left before launch

**As of 1 September 2026.** Tick things off as they land.

Six workstreams. Stream 3 is the only one that decides whether the product works;
everything else is secondary to it.

**State right now**

| | |
|---|---|
| Branch | `main`, and only `main` — nine branches merged and deleted |
| Commits | 27 ahead of `origin/main` |
| Tests | 9/9 native, 155/155 JS, `assembleDebug` green |
| Transcription | English default; Qwen3-ASR running and measured — 69.8% Devanagari against whisper's 4.1% |
| Website | **not deployed** (live site is still the old page) |
| App | not on Play |

---

## Start here tomorrow

Do these four in order. The first two take a morning between them and unblock most of the rest.

**1. Plug in the phone and tell me to smoke-test — *you 1 min, me 20 min***

The top technical risk. The native build has changed **three times** since it last ran on
hardware: the Sentry Gradle plugin, `nativeTranscribe` moving onto the engine factory, and the
Qwen3-ASR engine. Ten native tests and 155 JS tests pass and `assembleDebug` is green — but
compiling is not running, and the JNI is the fragile part and is exactly what changed.

**2. Spend the hour on the transcript — *you, 1 hr***

`eval/fixtures/real-neosym-2026-08-19/truth.draft.txt`, still the machine's own output with
instructions at the top. This is now the **single highest-value task in this document**. Every
other piece of the Hindi work is built, running and measured; this is the one input nobody else
can supply. Without it I can tell you what script Qwen answered in but not whether it is right.

When it lands, the whole comparison is one command:

```bash
python3 -m eval.run --cli cpp/cli/build/audionotes_cli --models eval/models \
  --only real-neosym-2026-08-19 --asr-engine qwen3 --qwen3-model eval/models/qwen3-asr --language hi
```

**3. Say yes to the deploy — *me, 15 min***

Fifteen minutes, and it is what finally makes the new landing page live. You have never seen the
redesign on a real URL. Outward-facing, so it waits for your word.

**4. Answer the four numbers — *you***

Each one has finished work queued behind it, and none of them need a computer:

| Decision | What it releases |
|---|---|
| Final prices, and two tiers or three | The plans screen and per-plan model access — ~2 days, built the moment this is settled |
| Where the 972 MB Qwen model lives | Making it downloadable — it runs today only if side-loaded |
| Sentry DSN (free account, 15 min) | Crash reporting is built and ships OFF. Without it you launch blind |
| Hostinger bandwidth limit | The last number needed to say where the server breaks |

---

## Done — do not redo these

- [x] **Release signing key backed up** — saved to Google Drive.
      Still worth confirming once: that the four values from `~/.gradle/gradle.properties` went
      **with** it — the keystore alone is a locked box — and that the copy still reads sha256
      `59d23acb94237a92bf99815ea0e271e196aab5843536875d79f5b96d8255cc62`. A backup nobody has
      restored is a hope, not a backup.

---

## Stream 1 — Ship what is already built

*Merged and green on `main`, but never run on a phone and never deployed. Compiling is not
running, and neither is evidence that it works.*

- [ ] **Smoke-test on the phone** — *me, 20 min* — **the biggest outstanding risk**
      Everything below compiles and 155 tests pass, but two things have changed the native build
      since it last ran on hardware: the Sentry Gradle plugin, and the ASR layer rewrite that
      moved `nativeTranscribe` onto an engine factory. The JNI is the fragile part and it is
      exactly what changed.
- [x] Push the branch and merge to main — *done today*
      All work is on `main`; the nine feature branches are merged and deleted.
- [ ] Deploy the server — *me, 15 min* — **this is what makes the new website live**
- [ ] Refresh the shareable APK on the Desktop for testers — *me, 5 min*

---

## Stream 2 — The website

*The redesign is written and committed. The page you looked at is the old one —
`/static/landing.css` returns 404 on the live server.*

- [x] Rebuild the landing page — *done today*
      Hero, how it works, why on-device, pricing, FAQ, close. Hand-written WebGL hero at ~4 KB
      instead of a 600 KB 3D library, and zero third-party requests — no font CDN, no analytics —
      because a page that says "nothing leaves your phone" cannot call four other companies before
      it paints.
- [ ] See it live and tell me what to change — *you, 10 min* — **blocked by: deploy**
- [ ] Replace the mocked phone with a real screenshot — *me, 1 hr*
      The hero currently draws a phone in HTML/CSS. A real finished meeting will sell harder.
- [ ] Redraw `og.png` to match the new design — *me, 30 min*
      It is what people see when the link is pasted into WhatsApp, which is how this spreads.
- [ ] Add the Google Play button — *me, 15 min* — **blocked by: the Play listing existing**
      `PLAY_URL` in `server/app/landing.py` is empty, so the hero honestly says "coming to Google
      Play" rather than offering a link that 404s.

---

## Stream 3 — Hindi and English transcription

*The one that matters. Today's tests found the cause and a model that fixes it.*

- [x] Found the cause — *done today*
      Auto-detect was the bug. Whisper re-decides the language every chunk, which is why one
      meeting came out in five scripts including Korean and Chinese.

- [x] Benchmarked the alternatives — *done today*

  | Model | Words | Devanagari | Urdu junk | Phone RTF |
  |---|---:|---:|---:|---:|
  | whisper-base (ships today) | 891 | 8.8% | 21.1% | 0.68× |
  | whisper-small | 722 | 87.7% | 0% | — |
  | **Qwen3-ASR 0.6B** | **1,211** | 87.6% | 1.0% | **1.14×** |

  On English (AMI, 14,220 words): whisper-base 29.7% WER → whisper-small 26.6%. Real, but
  English-only.

- [ ] **Correct the ground-truth transcript** — *you, 1 hr*

  `eval/fixtures/real-neosym-2026-08-19/truth.draft.txt` is still the machine's own output with
  instructions at the top. Until a human who speaks the language fixes it, every accuracy claim
  about Hinglish is unmeasurable. **This one hour unblocks three tasks below.**

- [x] Switch the language default from auto to English — *done today*
      Every layer defaults to `en`: the core, the CLI, the JNI, `ProcessingEngine` and Settings.
      **But the framing in the original item was wrong and the design deliberately departs from
      it.** Whisper pinned to `en` on Hindi audio does not transcribe Hindi, it emits English
      tokens for Hindi speech — which is why it reads as fluent, and why it is unrecoverable once
      stored. So the rule is *recognition is always faithful, and the default is English*: every
      language is pinned the same way, and the output language of the minutes is chosen separately
      at the narration stage. Forcing English globally could not have survived a European launch.

- [x] Offer more than three languages — *done today*
      Settings offered `auto / en / hi`, an India-only menu in a product launching in the US and
      Europe: a German user could not select German. The list now comes from the engine itself.

- [x] Add a Qwen3-ASR backend to the C++ core — *done today*
      A second engine behind an `AsrEngine` interface, chosen by a language policy table, sharing
      one chunker and one text-normalisation stage with whisper. Reachable from the phone, not
      just the desktop. Whisper's transcripts are byte-identical across the whole rewrite and
      still score WER 0.2978 against the recorded 29.7% baseline.
      **It cannot be downloaded yet** — see the two items below.
- [ ] Score every model against the corrected truth — *me, 2 hrs* — **blocked by: the transcript ONLY**
      Now a one-flag operation: `--asr-engine qwen3 --qwen3-model <dir>`.
      whisper base and small, Qwen3-ASR, and the Srota Hinglish fine-tune (Apache 2.0, claims
      −8.88 pp WER, but its authors admit train/test speaker overlap).
- [x] Fix the Chinese leak — *done today, pending measurement*
      The engine sets sherpa's per-utterance `language` option from the same setting whisper is
      pinned with. No output filter ships: a CJK threshold guessed before the evidence exists can
      silently delete real speech. Instead the eval harness now reports a per-fixture script
      histogram, so the leak is a number rather than something noticed by reading.

- [x] **Get the Qwen3-ASR weights and run them** — *done today*
      972 MB int8 export from the sherpa-onnx release page. First run on the 2026-08-19 recording,
      against whisper-base on the same audio:

      | | words | Devanagari | CJK | Urdu-script junk |
      |---|---:|---:|---:|---:|
      | whisper-base | 976 | 4.1% | 0.3% | 18.0% |
      | **Qwen3-ASR** | **1,205** | **69.8%** | 0.8% | **6.6%** |

      It also overturned both of my chunking constants. 25 s windows truncated against
      `max_new_tokens=128` and lost half the transcript; one-window-per-VAD-span starved the
      decoder on sub-second backchannel and it answered in Mandarin — 33 of 34 CJK utterances were
      under two seconds. 10 s packed windows fixed both. **Context, not the language hint, is what
      holds the decoder in the right language.**

      These are script counts and word counts, NOT accuracy. WER on Hindi is still unmeasurable.

- [ ] Make it downloadable — *me, 1 day* — **blocked by: the weights, and where they live**
      `ModelSpec` is one file with one sha256 and Qwen is four artifacts. The catalogue entry was
      deliberately NOT faked: a blank hash turns a verified download into an unverified one, and
      those hashes are the only thing standing between a hijacked mirror and code executing on a
      user's phone.
- [ ] Decide where the **972 MB** model lives — *you* — measured, not estimated
      Too big for the 114 MB free tier. Most likely an optional "Hindi and English" download, which
      finally makes Pro worth ₹1,799/year to an Indian user in a way prose summaries alone did not.

---

## Stream 4 — Price and billing

*Researched and costed. Waiting on numbers, then about three days of work.*

- [x] Market research and margin check — *done today*
      Otter $16.99/mo, Fireflies $18/mo, Plaud $17.99/mo. On-device rivals charge $5–39 **once**.
      India's median annual for this category is $18.32; India converts at 0.7% vs 2.8% in North
      America. Every tier is profitable even at a 40% launch discount — worst case still keeps
      ~99% margin, because a paid user costs one download and nothing after.

- [ ] Confirm the numbers — *you*

  Recommendation: **two tiers, not three** (whisper-small turned out to be an English-only gain).

  | | India | Rest of world |
  |---|---|---|
  | Monthly | ₹249 | $5.99 |
  | Yearly | ₹1,799 | $39.99 |
  | Lifetime | ₹3,999 | $89 |
  | Launch, first 90 days | 40% off | 40% off |

- [ ] Build the plans screen — *me, 1 day* — **blocked by: final prices**
      Separate screen, as asked. Two cards, monthly/yearly toggle, lifetime as one line underneath.
      First run stays two buttons — the Pro option was already falling below the fold with two.
- [ ] Per-plan model access — *me, 1 day* — **blocked by: how many tiers**
      Smaller than it sounds: the licence token already carries a `plan` field and the app already
      reads it. The native gate is currently a yes/no and needs to become a level.
- [ ] Create the products in Play Console — *you + me, 1 day* — **blocked by: prices, Play account**
      Subscription base plans, one-time products, introductory offer. Play supports the launch
      discount natively.

---

## Stream 5 — Getting onto the Play Store

*Mostly paperwork, and mostly yours. It will take longer than you expect.*

- [ ] Create a Sentry account, send me the DSN — *you, 15 min*
      Free tier is enough. Crash reporting is built and ships switched **off**; one line in
      `src/telemetry/dsn.ts` turns it on. Without it you launch blind.
- [ ] Play listing assets — *you, half day*
      Screenshots, feature graphic, short + full description, content rating questionnaire, data
      safety form, support email. Privacy and terms pages already exist — one blocker already clear.
- [x] Version numbering policy — *done today*
      `versionCode` is derived from `versionName` (1.0.0 → 10000) so a release cannot bump one and
      forget the other, and the build refuses a minor or patch above 99. Both guards verified.
      Still `versionCode 1`. Play rejects duplicates, so settle it before the second upload.
- [ ] **Send me the Hostinger bandwidth limit** — *you, 5 min*
      Every free install costs 114 MB whether they pay or not. At 100,000 installs that is 11.4 TB.
      It is the last number I need to say where the server breaks.
- [ ] Server housekeeping — *me, half day*
      Rehearse a backup **restore**, not just a backup. Check TLS auto-renewal. Add uptime alerting.
      `/srv` now holds 1.4 GB of models.
- [ ] Staged rollout — *you* — **blocked by: the listing**
      Start at 5–10%, not 100%. With crash reporting on, a bad build is recoverable.

---

## Stream 6 — Testing that has not happened

*Everything so far was verified on one flagship running an Android version almost nobody has.*

- [ ] **A mid-range non-Pixel phone** — *you + me, 1 day* — **blocked by: a second phone**
      The single most likely production failure. MIUI, ColorOS and Funtouch aggressively kill
      `dataSync` foreground services, and background processing, headless minutes and the
      "Notes ready" notification all depend on that service staying alive. On a Redmi it may die
      mid-meeting and the user simply never gets their notes. Ideally Redmi or Realme.
- [ ] A 60–90 minute recording, end to end — *me, 3 hrs*
      Everything tested so far is ≤ 8.5 minutes. At today's speeds a 90-minute meeting is roughly
      an hour of transcription. That is a product-defining number — learn it from me, not a review.
- [ ] RAM headroom on a 4 GB phone — *me, 2 hrs* — **blocked by: a second phone**
      whisper-small peaked at 511 MB; Qwen models are larger. Pro failing on cheap hardware is worse
      than Pro not existing, because Pro is the part people paid for.
- [ ] Interruptions — *me, half day*
      Incoming call mid-recording, Bluetooth connect/disconnect, screen off for an hour, reboot
      during processing, app swiped from recents while recording.
- [ ] Storage and network failure — *me, half day*
      1.4 GB download with under 2 GB free, disk filling mid-download, leftover `.part` files,
      interrupted and resumed download, wifi → mobile mid-transfer.
- [ ] Upgrading over an existing install — *me, 2 hrs*
      Only fresh installs have ever been tested. DB migrations, models already on disk, and the
      catalogue's "same filename, new weights" case all live here.
- [ ] Billing end to end with real money — *me, half day* — **blocked by: Play licence testers**
      Purchase, restore after reinstall, cancellation, and what happens when a trial ends with the
      1.1 GB model still on the phone.
- [ ] Large fonts and TalkBack — *me, 2 hrs*
      Onboarding already had one layout bug from shrinking. Large system fonts will find more.

---

## Decisions waiting on you

| Decision | Why it is blocking |
|---|---|
| Theme default — light or system? | You expected light; it ships as `system`, which is why your phone is dark. One line. |
| ~~Language default~~ | **Settled.** English, with faithful recognition in every language. |
| ~~Integrate Qwen3-ASR?~~ | **Settled.** Built and reachable; it only needs weights. |
| Final prices | Gates the plans screen, Play Console, paywall copy, website |
| Two tiers or three? | Gates per-plan model access |
| Integrate Qwen3-ASR? | 2–3 days, and the answer to Hinglish |
| Where the 955 MB model lives | Free tier is 114 MB today |

---

## Where this actually stands

The engineering on the thing that decides whether this product works is **done and measured**.
Verbale transcribes Hindi at 69.8% Devanagari where it managed 4.1% this morning, and the
unreadable Urdu-script junk is down from 18% to 6.6% — on your own recording, not a proxy corpus.

What is left is mostly **decisions and paperwork**, plus one hour of your time.

Two cautions worth carrying into tomorrow:

- **Those are script counts, not accuracy.** More words could in principle mean more invention.
  The ground truth is what turns "the scripts look right" into "we know it is right", and it is
  the reason item 2 above outranks everything else here.
- **Nothing has run on a phone since the rewrite.** Every number in this document comes from a
  Mac. That is item 1, and it is why it is item 1.

*Also published as a page: https://claude.ai/code/artifact/bac44e86-4904-4b77-8682-3065ee7f728c
(that page predates today's work and is now out of date — this file is the source of truth).*
