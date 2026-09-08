# Verbale — what to do next

**Written 5 September 2026.** Supersedes the ordering in `docs/LAUNCH.md`, which stays as the
detailed checklist for the store paperwork. Sourced from `docs/PRODUCT_RESEARCH_2026-09.md`; only
the items worth doing are here, in the order to do them.

**Two decisions this list is built on:**

1. **v1 is English only.** Already the state of the code. Hindi and Qwen3-ASR stay built and
   unreachable until a language has a word-error-rate number behind it.
2. **The launch is global, not India-first.** English-dominant business markets first: US, Europe,
   Australia, Singapore, plus English-medium meetings anywhere including India. This returns to the
   original cross-platform roadmap's market order.

**What follows from those two together, and it is the thing to hold on to:** English is no longer
one language among several. It is the entire product, so its error rate is the product's error
rate, and its failure modes are the product's failure modes.

---

## 0. What changed this week, because it reframes the list

A five-minute English meeting on a **Galaxy A07** — the first non-Pixel this has ever run on —
came back with three separate failures in one recording. It was nearly refused as Turkish, it
invented forty-three words out of room tone, and the refused state showed a live TRANSCRIBING
badge forever. All three are fixed and committed.

**Read that as evidence about where the risk is.** One meeting on one cheap phone found three
production bugs. Every previous test ran on a Pixel 7 Pro, which is not what most of the world
owns. Cheap-phone testing is currently the highest-yield activity in the project, and it is item 2
below for that reason.

---

## 1. Before launch

Ordered. Items 1 to 3 are the ones that decide whether this is worth shipping at all.

| # | What | Who | Size | Why it is here |
|---|---|---|---|---|
| 1 | ~~Smoke-test the current build on a phone~~ **DONE 6 Sep** | me | S | Ran end to end on the Pixel 7 Pro: onboarding, record, VAD, whisper, diarization, transcript, auto-title, export path and Settings, plus 16 native instrumentation tests with zero skips — the first genuinely green device run this project has had. Was still the top technical risk. The four native changes it was waiting on — the Sentry Gradle plugin, the engine factory, the Qwen engine and the detection rewrite — are all now exercised on hardware. |
| 2 | **Two more mid-range non-Pixel phones, end to end** | you + me | M | The A07 found three bugs in one meeting. Redmi, Realme or Samsung A-series. MIUI, ColorOS and Funtouch also kill `dataSync` foreground services aggressively, which is what background processing, headless minutes and the "Notes ready" notification all depend on. A meeting that dies mid-recording on a Redmi is a user who never gets their notes and never comes back. |
| 3 | ~~Measure Parakeet-TDT and Moonshine v2 against whisper-base~~ **DONE 5 Sep — do not swap** | me | S | **Parakeet-TDT 20.2% WER against whisper's 29.0% on identical audio, and it cannot ship.** It returns an empty string on quiet windows and reports success — 60% of windows lost on two of four AMI meetings, ×3 gain recovers them, sherpa logs no error. Also 661 MB against 57 MB, 1.7 GB peak RSS, 2.4-2.9x the ASR time. Moonshine 27.2%, no cliff, not worth 5x the download for 6%. **fp16 checked and ruled out:** same cliff at the same threshold, emitting `<unk>` spam instead of silence, 1.26 GB and 15x slower. Full numbers and what to check next: `docs/superpowers/eval-english-engine-candidates.md`. |
| 4 | ~~Build an accent-diverse English test set~~ **DONE 5 Sep — no cliff found** | me | S | Six EdAcc conversations (CC BY-SA), real references rather than corrected-transcript lower bounds, so no recording session was needed. **WER 23.3%–30.2% across American, Scottish, Indian, Kenyan, Southern London and Nigerian — under seven points end to end, no accent falls off a cliff.** Scottish is NOT the hard case (23.4%, tied with American); native-vs-non-native predicts nothing (Southern London is second worst). The real finding is Indian English at **79.1% attribution** — words right, speaker wrong, which is diarization not ASR. Australian and Singaporean remain unmeasured: EdAcc has neither, and that is what a recording session should target. `docs/superpowers/eval-accent-baseline.md`. |
| 5 | **A 60 to 90 minute meeting** — *processing measured; **guard shipped, windowing shelved, device gate open*** | me | S | Measured 6 Sep by importing 90.0 min of real AMI meeting audio on the Pixel 7 Pro (recording a quiet room would have been meaningless: VAD strips silence, so ASR would barely run). **ASR is fine and the headline number is good: 0.34x realtime — 30.9 min for 90 min, 176 chunks, zero failures — and it holds, since a 22-second clip the same morning measured 0.30x.** VAD is free at 0.01x (45.8 s). **Diarization is the problem, though not in the way it first looked.** A 22.7-minute recording the same evening measured it at **0.64x realtime** and it finished cleanly — so the 0.67 constant was right all along and the 90-minute run was not hung, just about eleven minutes from finishing when it was killed at 47. The real cost is memory and total time: **2.55 GB PSS / 1.38 GB native heap, 124 MB swapped, and nine background apps evicted by Android on a 12 GB phone.** Stacked up, VAD + ASR + diarization runs at roughly **1.0-1.2x realtime on real captured audio** (ASR measured 0.34x on clean AMI headset audio but 0.53x on a real room), which means **processing a meeting takes about as long as the meeting did** — the product-defining number this item existed to find. Root cause is in the code and its own comment says so: `cpp/diar/diarizer.cpp:122` does `readAll()` of the entire recording into a `vector<float>` — 346 MB of input buffer for 90 min before sherpa's own copies — and `diarizer.cpp:82` records that diarization covers "the WHOLE recording (not just the VAD spans)", where ASR has always been restricted to speech. So it is doing the silence too, in RAM, all at once. **The first fix was the wrong fix, and the measurement that says so is `eval/speech_fraction.py`.** Moving diarization onto the VAD spans (`a1ea433`) was built as the memory fix. It is not one: padded speech covers **73.4% / 86.9% / 73.0% / 62.1%** of ES2002a / ES2002b / IS1000a / ES2003a, so skipping the silence saves **13-38%**. Most of a real meeting IS speech. That is a constant factor on a cost that still grows with the recording — 90 minutes goes from 2.55 GB to roughly 1.9 GB and a three-hour meeting fails exactly as before. The spans moved the cliff; they did not remove it. They were worth keeping for a different reason than the one they were built for: with 500 ms of real silence padded back at each boundary they IMPROVED accuracy (mean DER 20.4 -> 20.0, attribution 87.2 -> 88.4), and 1000 ms was tried and was worse. **Windowing was built, measured, and SHELVED.** `windowSpans()` cuts the padded spans into ten-minute pieces, each read, diarized and freed before the next, so the peak follows the window and not the meeting. It works and it is too expensive: **mean DER 26.2-27.7 against 20.0 for one pass, attribution 81.5-84.1 against 88.4**, over two rounds of trying. The cost is structural — each window is clustered on its own, so the windows must work out afterwards which of their speakers were the same people, from one averaged voice each where sherpa had every per-segment embedding. Three things were learned and are worth keeping: reusing sherpa's own 1.0 threshold collapsed four speakers into one (these are AVERAGES, and averaging pulls every vector toward the middle of its cluster — the pairwise distances were packed into 0.25-0.95, all under 1.0); tuning the replacement on ES2002a alone looked like a win and cost 7.7 DER points across all four, which is why the padding constant was swept on four; and the two remaining failures were opposite — ES2002b over-split one speaker into two (complete linkage needs all six pairs close, so one quiet window blocks the group -> average linkage) while ES2003a merged five speakers into three (the clustering was overruling sherpa's within-window judgement on weaker evidence -> a cannot-link constraint). Both fixes are right and unit-tested and still left six points on the table. `kDiarWindowMs` is 0 and `scripts/check-diar-constants.py` fails if it or `DiarBudget.WHOLE_MEETING` drifts, because that failure is silent. The honest next attempt is per-segment embeddings clustered globally, and it starts from this code. **What ships is the guard**: an hour to ninety minutes is an ORDINARY meeting here — rooms run over in a way calls do not — so speaker labels are not tradeable, and diarizing in windows to save memory trades exactly them. `DiarBudget` instead asks one question, does the whole meeting fit, and skips diarization outright when it does not, with a sentence stored on the meeting and shown on its screen. It claims three quarters of what is free rather than half, so it almost never trips: the 22.7-minute recording that ran at 0.64x and 90 minutes on a 12 GB phone both clear it comfortably. Losing speaker labels costs a Speakers screen the user can fill in by hand; being OOM-killed costs the meeting, because minutes and narration both run after this stage. **Note the 90-minute evidence is weaker than it was first written up as: that run was an IMPORTED AMI file, not a capture, and it was killed at 47 minutes about eleven from finishing — it was never observed to fail.** `docs/superpowers/specs/2026-09-06-windowed-diarization-design.md`. Still untested: the 90-minute CAPTURE path — disk growth, wake lock, service longevity — which needs 90 minutes of wall clock and is best run overnight. |
| 6 | ~~Give the refused meeting a next step~~ **DONE 6 Sep** | me | S | Most of this already shipped; the gap was the refusal being WRONG (English heard as Turkish at p=0.88 on the A07), with Redo re-running the same detection to the same verdict. Merged: a per-meeting "Transcribe it anyway" that states both outcomes before, and marks the result forever after — in the app and in every export, because the forwarded PDF is where invented minutes do harm. **Device gate closed 6 Sep**: `npm run test:device` on the Pixel 7 Pro ran 16 tests with zero skips — the first genuinely green run on this phone, and the one that proves the changed JNI signature survives the boundary. The seven manual UI steps in the plan are still unticked. Spec + plan: `docs/superpowers/specs/2026-09-05-transcribe-it-anyway-design.md`, `docs/superpowers/plans/2026-09-05-transcribe-it-anyway.md`. |
| 7 | **The consent kit** — *code complete, **two gates open*** | me | S | Built: the disclosure is spoken into the LIVE microphone — the first statement after `startRecording()`, not the setup path above it — so it lands in the audio and becomes the first line of the transcript. The recording carries its own proof the room was told, and that proof travels with the exported file; a consent flag in a local database proves nothing to anybody off the phone. A bundled clip rather than TTS, because Google's TTS synthesises over the network and item 8 claims one network call a month. `announced_at` is stamped only on confirmed playback completion, never on a silenced or failed one. Defaults on everywhere, overridable in Settings; region changes the card's wording, never the announcement's. The app reports what it did and never that anybody is compliant — a unit test asserts the words "legal" and "complian" appear nowhere in the card, in any region. **Device-verified 6 Sep on the Pixel 7 Pro**: the card renders and picks the right region wording, the Settings toggle persists, switching it off produces silence and no false failure, and on a good run the transcript's first line is the disclosure — the meeting even auto-titled itself from it. **(b) FIXED 6 Sep, pending a device run.** The earlier reading of this was wrong and the correction matters: the clip was not missing from those recordings, it was too quiet to be evidence. Sample-level cross-correlation finds it in five of the six (peak-over-background 2.58 to 9.91); the sixth is the one where the setting was off, at 1.04. What varies is the LEVEL — in three of the five it arrived so far under the room that the pipeline returned "no speech found", and no transcript would carry it. `AnnouncementVerifier` now asks the recording both questions before stamping: is this clip present (correlation, which also stops a loud voice at the start being mistaken for an announcement), and was it loud enough to be evidence (1.57 and 3.51 for the two that worked, against 1.01, 1.09 and 1.33 for the three that did not). The verdict is logged every run, because the thresholds come from one phone. Real envelopes from all six are committed as fixtures — loudness curves, not audio, so they cannot be inverted to speech. **Device-verified 6 Sep 17:01**: `announcement check: heard=true found=true peak/bg=11.82 loudness=2.35 lag=240ms` — the clip located 240 ms into the capture, 11.8x above the correlation background and 2.35x the room's loudness, and the transcript's first line was the disclosure. A full record → VAD → whisper → diarize cycle immediately afterwards left the privacy screen reading zero network calls, which is the on-device proof that transcription touches nothing. **Outstanding: (a) the shipped clip is still a synthesised placeholder and must be replaced with a human recording before launch — whisper hears "Verbale" as "Verbal" in the synthesised voice.** `docs/superpowers/specs/2026-09-05-consent-kit-design.md`, `docs/superpowers/plans/2026-09-06-consent-kit.md`. |
| 8 | ~~Privacy proof screen~~ **DONE 6 Sep** | me | S | Settings → "What left this phone": every network call this app has made, counted at the four call sites that own its entire network access, with dates, hosts and byte totals, and the full log behind the summary. The app claimed "nothing is uploaded" in six places and none of them was checkable by the person reading it — this is the check. Counts the one-time model download in full with its domains rather than hiding it (1.3 GB came down so that nothing has to go up) and states plainly the one thing it cannot count, which is Google Play's own connection. A failed ledger write is surfaced rather than swallowed, because a screen that reads low is the same overclaim as the consent bug fixed the same day. `npm run check:egress` fails the build if a fifth call site appears — verified by planting a fetch in LibraryScreen and watching it fail, so the allowlist is not quietly covering everything. **Device-verified 6 Sep**: reads "No network calls / 0 bytes sent / 0 bytes of audio" on a phone that has recorded and transcribed, which is the claim the whole product rests on. The setup card is correctly absent on this device because its models predate the ledger; a fresh install will show it. `docs/superpowers/specs/2026-09-06-privacy-proof-design.md`, `docs/superpowers/plans/2026-09-06-privacy-proof.md`. |
| 9 | **Final prices, in USD, EUR, GBP, AUD, SGD and INR** | you | — | Two tiers. Play regional pricing. The plans screen and per-plan model access are about two days of work and are entirely blocked on this. |
| 10 | **Sentry DSN** | you, 15 min | — | Free account. Crash reporting is built and ships off. Without it, launching on unfamiliar hardware means launching blind, which items 1 and 2 say is the actual risk. |
| 11 | **Play listing, with "English only" in the first line** | you, half a day | M | Screenshots, feature graphic, descriptions, content rating, data safety. The English-only statement is not fine print: a user who records Hindi, gets refused and was not told is a one-star review. |
| 12 | **Deploy the website** | me, 15 min | S | Outward-facing, so it waits for your word. It is what makes the new landing page live. |
| 13 | **Hostinger bandwidth ceiling** | you, 5 min | — | Easier now: Pro is about 1.1 GB rather than 2.2 GB. Still the last number needed to say where the server breaks. |
| 14 | **Staged rollout at 5 to 10%** | you | — | With crash reporting on, a bad build is recoverable. At 100% it is not. |

---

## 2. First six weeks after launch

Small, high-value, and each one answers a complaint the whole category gets.

- **Mark a moment.** One button on the record screen, the picture-in-picture pane, the Quick
  Settings tile and the notification. Markers become a Highlights section and feed the narrator.
  Plaud built hardware for this. About a day here. Research §3.2.
- **Reassign the speaker on a turn, and split or merge turns.** Text is editable today; who said
  it is not. Wrong attribution is the top diarization complaint in every review. Research §2.3 #11.
  **Item 4 turned this into a measured defect rather than a category complaint:** Indian-accented
  English scores 79.1% attribution against 92.6% for American — same recogniser, same settings.
  Until diarization improves, this screen is the mitigation, and India is a named market.
- **Provenance.** Tap a decision, land on the transcript turn, play from there. This is what
  "minutes you would forward without editing" actually means. Research §2.3 #10.
- **An honest ETA while processing — and the right stage.** **Measured 6 Sep on a 90-minute
  import, and this may belong in §1 rather than here.** Two defects, both only visible on a long
  meeting. (1) The screen showed the spinner on stage 1, "Audio cleaned up", for twenty-four
  minutes after VAD had actually finished — so the longest stage, ASR, renders as if nothing has
  started. (2) The ETA is not measured at all: `MeetingScreen.tsx:70-79` holds hard-coded
  ×realtime constants, and "236 min left" is exactly `2.618 × 5400 s` falling out of them. The ASR
  constant is 1.47× realtime, from whisper-base at 0.68×; this same phone measured **0.30×** the
  same day, so the estimate is roughly five times pessimistic on top of being anchored to the
  wrong stage. A first-time user watching a 90-minute meeting claim four hours closes the app.
  **This also disguises the fast paths:** a silent recording already skips ASR and diarization
  entirely (`ProcessingEngine.kt:180`, "no speech detected") and finishes in about a minute — but
  the screen spends that minute insisting on four hours, so the early exit reads as a hang.
- **Meeting types.** Stand-up, one-to-one, client call, interview, lecture, site walk. On device
  these are prompt and section variants. Research §2.4 #13.
- **Share sheet and DOCX export.** Exports are Markdown, text, SRT and PDF. DOCX is what a
  business user forwards. Research §2.4 #14.
- **Fix the free-tier document.** Lead with the actions list and a composed paragraph, never a
  count. It is what a free user shows a colleague, which is the whole acquisition loop.
- **Grammar-constrained narration.** JSON-schema sampling in llama.cpp deletes a bug class that
  `summarize.ts` currently defends against by hand.

---

## 3. The moat, once the product is stable

- **Persistent speakers ("People").** Name someone once, recognise them next meeting, using the
  voice embeddings already computed for diarization. No offline app has this and Pixel explicitly
  does not. **Legal note for a global launch:** a stored voice embedding tied to a name is
  biometric data under Illinois BIPA and GDPR Article 9. Staying on device is most of the answer,
  but this feature needs consent copy written before it ships, not after. Research §3.1.
- **Ask your meetings, offline.** Retrieval into the writer model, answering with citations to the
  turns used. The category flagship, and the only private one. This is the reason to buy Pro.
- **Calendar-aware capture, read only.** Nudge before a meeting, pre-title it, offer invitees as
  speaker names. Invitees are the best source of speaker names that exists.
- **The correction loop.** Names and terms fixed once become a glossary that biases both the
  recogniser and the narrator. Accuracy that compounds per user is something no one-time app can
  copy.
- **Weekly digest and a home widget.** The habit loop on top of the streak card.

---

## 4. Later, in this order

1. **Live transcript, two-pass — i.e. transcribe DURING the recording.** Streaming model during
   capture, offline model after. Halves the perceived wait and is the largest perceived-quality
   lever left. Research §2.2 #8.

   **Already investigated 10 Aug; the two native blockers were re-verified 6 Sep and both still
   hold.** Do not re-investigate from scratch — the shape of the work is known:
   - **Whisper reloads the model on every call.** `audionotes_jni.cpp:138` constructs a fresh
     engine per `nativeTranscribe`, and `whisper_asr.cpp:65` initialises the context in that
     object's constructor. Streaming needs a handle-based API — `nativeAsrOpen/Feed/Close` —
     mirroring the LLM, which already does exactly this (`nativeLlmLoad/Generate/Free`,
     `audionotes_jni.cpp:212-242`).
   - **There is no live VAD during capture.** `CaptureController.level` is an RMS meter and
     `silenced` only reports system mute. Silero is internally frame-streaming but is exposed
     whole-file only, so a streaming VAD handle is needed alongside.

   **New evidence, 6 Sep:** the 90-minute import spent over half an hour in ASR alone while the
   screen showed a four-hour estimate. Post-hoc transcription means the wait scales with meeting
   length at exactly the moment the user wants their notes; transcribing during capture means a
   90-minute meeting is nearly done when they press stop. That argues for promoting this above
   the other §4 items once the launch list is clear.
2. **Languages beyond English, one at a time, each with a number.** Hindi first, since Qwen3-ASR is
   already built, measured and one routing-table row away. Then IndicConformer for the languages
   Qwen3 does not cover.
3. **Desktop, macOS and Windows.** The same C++ core, heavy models, and loopback capture for online
   meetings with no bot. This is where the premium tier becomes real.
4. **iOS.** After Android converts. Sell languages, people and actions, because Apple gives away
   English transcription.

---

## 5. Parked on purpose — do not re-raise without new evidence

- **Anything cloud, any meeting bot, any auto-join.** The lawsuit environment is the moat's fence.
- **Gemini Nano or AICore as an engine.** On device, but a third-party model. It breaks the one
  hard promise.
- **Recording gain normalisation.** Built, measured, rejected. It made things worse on the exact
  recordings it was written to rescue. See `docs/superpowers/specs/2026-09-04-recording-gain-rejected.md`.
- **A multi-language claim in the store listing.** A language appears when it has a measurement.
  That rule is the product.
- **India-specific launches — clinic notes, a WhatsApp-first flow, a rupee lifetime SKU.** Good
  ideas, wrong order for a global English launch. Revisit when Hindi ships.
- **Always-on wearable capture.** Meta bought Limitless, Amazon bought Bee. Not this company.
