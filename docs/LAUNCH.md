# Verbale — everything left before launch

**As of 1 September 2026.** Tick things off as they land.
**Amended 5 September 2026: v1 ships English only** — see the decision below.

> **22 September 2026 — this file is history, not the list.** The live list is `docs/NEXT.md` §1 and the release
> plan `docs/superpowers/plans/2026-09-17-release-phases.md`; the store paperwork is `docs/play-console.md`,
> re-checked against the code that day. Several boxes below are done and were never ticked (the phone smoke
> test, the server deploy, the website); others name things that no longer exist (`verbale_pro_monthly` — the
> product is `verbale_pro` with two base plans). Read it for the reasoning; do not work from it.

Six workstreams. Stream 3 decided what the product *is*, and it is now decided; what remains
of it is post-launch. Streams 5 and 6 are what stand between here and the store.

## The decision: v1 is English only

Taken 5 September 2026. **This is already the state of the code**, so it costs nothing to
implement: `cpp/asr/asr_languages.cpp` carries one row, the picker carries one row, and `auto`
is gone on purpose. Hindi and Qwen3-ASR stay built, measured and unreachable until a language
has a WER number behind it.

**What it removes from this list** — the corrected Hinglish ground truth, the 972 MB model
hosting decision, making Qwen downloadable, and scoring every model against that truth. All four
move to post-launch. Pro's first-run download drops from ~2.2 GB to ~1.1 GB, which roughly halves
Pro egress and makes the Hostinger question easier, not harder.

**What it makes more important, and this is the trade being accepted:**

1. **English quality is now the entire product.** 29.7% WER is no longer one language among
   several; it is the thing being sold. Measuring Parakeet-TDT and Moonshine before launch is an
   afternoon and could halve that number. See `docs/PRODUCT_RESEARCH_2026-09.md` §2.1.
2. **More users will meet the refusal.** Anyone recording Hindi now gets "NOT ENGLISH" instead of
   nonsense, which is correct, but it must be expected rather than discovered. The Play listing has
   to say English only in the first line, and the refused-meeting state needs its next step
   (research §2.4 #15) or it reads as a bug and earns one-star reviews.
3. **India is narrowed, not lost.** The 0.60 detection threshold was set so code-switched Indian
   English stays on the transcribing side. English-medium meetings in India still work, which is
   what the ₹249 / ₹1,799 tier rests on.

**State right now**

| | |
|---|---|
| Branch | `main`, and only `main` — nine branches merged and deleted |
| Commits | 27 ahead of `origin/main` |
| Tests | 9/9 native, 155/155 JS, `assembleDebug` green |
| Transcription | **English only, and refuses rather than fabricates.** Qwen3-ASR built and measured (69.8% Devanagari against whisper's 4.1%) but unreachable in v1 |
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

**2. Let me measure the English engines — *you 1 min, me half a day***

Replaces "correct the Hinglish transcript", which the English-only decision moved to post-launch.
English is now the whole product, so its error rate is the product's error rate:

| Engine | WER on AMI | Status |
|---|---|---|
| whisper-base (ships today) | 29.7% | measured here |
| whisper-small (Pro) | 26.6% | measured here |
| Parakeet-TDT 0.6B v3 | ~16% | published, not yet run here |
| Moonshine v2 | large-v3 parity claimed | published, not yet run here |

Both candidates sit behind the `AsrEngine` factory that already exists and run on the sherpa-onnx
runtime already vendored. If Parakeet holds up, one model swap roughly halves the error rate of
everything Verbale sells. Worth knowing before the listing goes live, not after.

**3. Say yes to the deploy — *me, 15 min***

Fifteen minutes, and it is what finally makes the new landing page live. You have never seen the
redesign on a real URL. Outward-facing, so it waits for your word.

**4. Answer the three numbers — *you***

Each one has finished work queued behind it, and none of them need a computer. The Qwen hosting
question is gone: English-only means it does not ship in v1.

| Decision | What it releases |
|---|---|
| ~~Final prices, and two tiers or three~~ **decided** | Two tiers; ₹299 / ₹2,499 and $4.99 / $39.99. The plans screen shipped 7 Sep. What remains is creating `verbale_pro` in Play Console |
| ~~Sentry DSN~~ **closed 12 Sep** | Not Sentry — Firebase Crashlytics (`00f08a4`), configured by the committed `android/app/google-services.json`. Nothing to send. Still ships OFF until the user says yes |
| ~~Hostinger bandwidth limit~~ **closed 12 Sep** | Founder confirmed the hosting has enough bandwidth for launch. Nothing to send |

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

*The one that mattered, and it is answered. Everything ticked below stays; **every unticked item
in this stream is now POST-LAUNCH** by the English-only decision at the top of this file. Do not
let them block the store.*

*What replaces them before launch: measure Parakeet-TDT and Moonshine against whisper-base on AMI
(item 2 of "Start here tomorrow"), and give the refused-meeting state a next step so "NOT ENGLISH"
reads as a decision rather than a failure.*

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

- [x] ~~Confirm the numbers~~ — *decided by 7 Sep, recorded 13 Sep*

  **Two tiers, Free and Pro. No lifetime SKU** (parked, `docs/NEXT.md` §5). The table below is
  what shipped, not the earlier ₹249 / $5.99 recommendation:

  | | India | Rest of world |
  |---|---|---|
  | Monthly | ₹299 | $4.99 |
  | Yearly | ₹2,499 | $39.99 |

  Public on the landing page (`server/app/landing.py`) and fixed in the billing tests as "the
  founder's launch prices". A launch discount, if any, is an introductory offer in Play Console —
  the paywall then shows Play's own full price struck through, which is the only honest way to
  show one.

- [x] ~~Build the plans screen~~ — *done 7 Sep* (`42fbda2`, `810c279`)
      Lives on the paywall rather than a separate screen: two cards, yearly preselected, the
      saving computed from twelve months of the monthly rate. Prices are read live from Play, not
      hard-coded. First run stays two buttons.
- [x] ~~Per-plan model access~~ — *moot with two tiers*
      The native gate is a yes/no, and with Free and Pro that is the design. Reopens only if a
      third tier does.
- [ ] Create the product in Play Console — *you + me, ~1 hr* — **the one thing still open here**
      One subscription, id `verbale_pro` (must match `playSubscriptionId` in
      `android/gradle.properties`), with two base plans, `monthly` and `annual`, priced as above.
      No one-time products. A launch discount, if wanted, is an introductory offer on the same
      product. Then a licensed tester buys through the paywall on a phone — the first time a real
      Play price will ever have been seen in the app.

---

## Stream 5 — Getting onto the Play Store

*Mostly paperwork, and mostly yours. It will take longer than you expect.*

- [x] ~~Create a Sentry account, send me the DSN~~ — *closed 12 Sep: not Sentry*
      Crash reporting is Firebase Crashlytics (`00f08a4`), configured by the committed
      `android/app/google-services.json`, so there is nothing to create or send. It still ships
      switched **off** until the user says yes, and debug builds never report —
      `src/telemetry/crash.ts`, `src/telemetry/enabled.ts`.
- [ ] Play listing assets — *you, half day*
      Screenshots, feature graphic, short + full description, content rating questionnaire, data
      safety form, support email. Privacy and terms pages already exist — one blocker already clear.
- [x] Version numbering policy — *done today*
      `versionCode` is derived from `versionName` (1.0.0 → 10000) so a release cannot bump one and
      forget the other, and the build refuses a minor or patch above 99. Both guards verified.
      Still `versionCode 1`. Play rejects duplicates, so settle it before the second upload.
- [x] ~~Send me the Hostinger bandwidth limit~~ — *closed 12 Sep: hosting has enough*
      Founder confirmed the plan's bandwidth covers launch. The arithmetic stays for the record:
      every free install costs 114 MB whether they pay or not, so 100,000 installs is 11.4 TB.
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
| ~~Final prices~~ decided | ₹299 / ₹2,499 and $4.99 / $39.99. Plans screen, paywall copy and website are done; only the Play Console product is still open |
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
