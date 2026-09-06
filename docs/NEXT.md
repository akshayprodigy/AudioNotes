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
| 1 | **Smoke-test the current build on a phone** | you 1 min, me 20 min | S | Still the top technical risk. The native build has changed four times since it last ran on hardware: the Sentry Gradle plugin, the engine factory, the Qwen engine, and this week's detection rewrite. Compiling is not running, and the JNI is exactly what changed. |
| 2 | **Two more mid-range non-Pixel phones, end to end** | you + me | M | The A07 found three bugs in one meeting. Redmi, Realme or Samsung A-series. MIUI, ColorOS and Funtouch also kill `dataSync` foreground services aggressively, which is what background processing, headless minutes and the "Notes ready" notification all depend on. A meeting that dies mid-recording on a Redmi is a user who never gets their notes and never comes back. |
| 3 | ~~Measure Parakeet-TDT and Moonshine v2 against whisper-base~~ **DONE 5 Sep — do not swap** | me | S | **Parakeet-TDT 20.2% WER against whisper's 29.0% on identical audio, and it cannot ship.** It returns an empty string on quiet windows and reports success — 60% of windows lost on two of four AMI meetings, ×3 gain recovers them, sherpa logs no error. Also 661 MB against 57 MB, 1.7 GB peak RSS, 2.4-2.9x the ASR time. Moonshine 27.2%, no cliff, not worth 5x the download for 6%. **fp16 checked and ruled out:** same cliff at the same threshold, emitting `<unk>` spam instead of silence, 1.26 GB and 15x slower. Full numbers and what to check next: `docs/superpowers/eval-english-engine-candidates.md`. |
| 4 | ~~Build an accent-diverse English test set~~ **DONE 5 Sep — no cliff found** | me | S | Six EdAcc conversations (CC BY-SA), real references rather than corrected-transcript lower bounds, so no recording session was needed. **WER 23.3%–30.2% across American, Scottish, Indian, Kenyan, Southern London and Nigerian — under seven points end to end, no accent falls off a cliff.** Scottish is NOT the hard case (23.4%, tied with American); native-vs-non-native predicts nothing (Southern London is second worst). The real finding is Indian English at **79.1% attribution** — words right, speaker wrong, which is diarization not ASR. Australian and Singaporean remain unmeasured: EdAcc has neither, and that is what a recording session should target. `docs/superpowers/eval-accent-baseline.md`. |
| 5 | **A 60 to 90 minute recording, end to end** | me, 3 hrs | S | Everything tested so far is under nine minutes. At current speed a 90-minute meeting is roughly an hour of transcription. That is a product-defining number, and it should be learned here rather than from a review. |
| 6 | ~~Give the refused meeting a next step~~ **DONE 6 Sep** | me | S | Most of this already shipped; the gap was the refusal being WRONG (English heard as Turkish at p=0.88 on the A07), with Redo re-running the same detection to the same verdict. Merged: a per-meeting "Transcribe it anyway" that states both outcomes before, and marks the result forever after — in the app and in every export, because the forwarded PDF is where invented minutes do harm. **Device gate closed 6 Sep**: `npm run test:device` on the Pixel 7 Pro ran 16 tests with zero skips — the first genuinely green run on this phone, and the one that proves the changed JNI signature survives the boundary. The seven manual UI steps in the plan are still unticked. Spec + plan: `docs/superpowers/specs/2026-09-05-transcribe-it-anyway-design.md`, `docs/superpowers/plans/2026-09-05-transcribe-it-anyway.md`. |
| 7 | **The consent kit** — *code complete, **two gates open*** | me | S | Built: the disclosure is spoken into the LIVE microphone — the first statement after `startRecording()`, not the setup path above it — so it lands in the audio and becomes the first line of the transcript. The recording carries its own proof the room was told, and that proof travels with the exported file; a consent flag in a local database proves nothing to anybody off the phone. A bundled clip rather than TTS, because Google's TTS synthesises over the network and item 8 claims one network call a month. `announced_at` is stamped only on confirmed playback completion, never on a silenced or failed one. Defaults on everywhere, overridable in Settings; region changes the card's wording, never the announcement's. The app reports what it did and never that anybody is compliant — a unit test asserts the words "legal" and "complian" appear nowhere in the card, in any region. **Outstanding: (a) the shipped clip is a synthesised placeholder and must be replaced with a human recording before launch; (b) nobody has yet confirmed the announcement is audible in a real recording — the only check that decides whether this is real or decorative.** `docs/superpowers/specs/2026-09-05-consent-kit-design.md`, `docs/superpowers/plans/2026-09-06-consent-kit.md`. |
| 8 | **Privacy proof screen** | me, 1 day | S | "Network calls this month: 1 licence check. Audio uploaded: 0 bytes." The GDPR and enterprise-buyer asset, and the thing people screenshot. Research §3.11. |
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
- **An honest ETA while processing.** Measured realtime factor times remaining speech. The stages
  already report progress; the number that reassures is minutes left.
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

1. **Live transcript, two-pass.** Streaming model during capture, offline model after. Halves the
   perceived wait and is the largest perceived-quality lever left. Research §2.2 #8.
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
