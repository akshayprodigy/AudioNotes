# Verbale — what world class looks like from here

**Date:** 2026-09-04
**Lens:** product research — the 2026 landscape, the engine, and the product — against `main` at
`8ea6f60` plus the uncommitted language-refusal work.
**Companions:** `docs/PRODUCT_REVIEW_2026-08.md` (the August review, now almost entirely built),
`docs/LAUNCH.md`, `docs/superpowers/specs/2026-08-12-in-person-mom-cross-platform-roadmap.md`.

Every recommendation below carries an evidence tag so it can be argued with:
**measured here** (a number from `eval/` or a device), **published** (a vendor or paper figure,
not yet reproduced on our stack), **estimate** (my judgement).

---

## TL;DR

1. **The moat is real and nobody else is standing on it.** In-person, on-device, resumable,
   and — since this week — a product that refuses rather than fabricates. The on-device segment
   has no Android app with speaker identification, none with Indian languages, and none with
   ask-across-meetings. Verbale can own all three.
2. **The engine is the gap, and it is a cheap gap.** whisper-base scores 29.7% WER on AMI
   *(measured here)*. A 2026 English model on the same sherpa-onnx runtime scores about half that
   *(published)*. The `AsrEngine` factory and the harness mean this is an afternoon to measure and a
   week to ship. It is the single largest quality lever in the product.
3. **Bengali is not unsupported — it is un-added.** AI4Bharat's IndicConformer covers all 22
   scheduled languages, is MIT-licensed, exports to ONNX, and reports 13.2% Hindi WER *(published)*.
   It is a third engine behind the existing factory, added one measured language at a time.
4. **The category's 2026 bar moved from "record → wait → read" to "capture → live → act → ask."**
   Live transcript, a mark-this-moment button, persistent speakers, and offline Q&A are the four
   features that close it. All four run on the device.
5. **Trust is the brand, so make it visible.** Per-word confidence, minutes that cite the moment
   they came from, and a consent kit turn the honest engine into an honest interface. Competitors
   are being sued for the opposite.

---

## 1. Where the bar is in 2026

| Product | What it does well now | Where it is weak | Relevance to Verbale |
|---|---|---|---|
| **Otter** (35M users) | "Conversational knowledge engine": AI chat across every meeting, meeting agents, MCP server, desktop app | Cloud; auto-join bot; consolidated wiretap class action, 23-page order issued 2026-08-13 | Ask-across-meetings is the flagship. Consent is their open wound |
| **Fireflies / Fathom / tl;dv** | 100+ integrations, CRM logging, 100+ languages | Cloud bots inside calls; accuracy 85–95% only on clean audio | Online meetings — a non-goal. Ignore |
| **Granola** | "Enhance my notes": your typed notes + transcript; Recipes (prompt lenses); chat; Apple Watch; Android since July 2026; tablet layouts | Cloud; $14/mo | The typed-notes-plus-transcript model and Recipes are the two product ideas worth borrowing |
| **Plaud** (hardware + app) | Highlight button on NotePin S; 10,000+ templates; Ask Plaud; industry glossary; desktop app without a bot | Cloud; 300 free min/month, $99.99/yr for 1,200; reviewers call the app "way too confusing" | Mark-a-moment, templates and glossary are directly portable. Their minute caps are a pricing opening |
| **Pixel Recorder** | Free, on-device, real-time speaker labels, re-transcribe in 40+ languages, summaries on Pixel 8+ | Pixel only; speaker labels English only; anonymous labels never persist | The closest technical peer. Its two-pass design (live then offline) is the pattern for live transcript |
| **Apple Notes / Voice Memos (iOS 26)** | On-device transcript with speaker labels, Apple Intelligence summary, call recording with an announcement | English-centric; no minutes, actions or cross-meeting memory | Sets the iOS floor. An iOS port must sell languages, speakers and actions, not transcription |
| **Samsung Transcript Assist** | Offline with language packs, including Hindi and Indian English | Summaries need the network; Samsung only | Confirms Hindi is a table-stakes expectation on Indian flagships |
| **Limitless / Bee** | Always-on lifelogging; Limitless shipped a consent chime | Limitless acquired by Meta, no longer sold; Bee is Amazon's | The consent chime is the one idea to take |
| **Voicenotes / AudioPen** | Personal voice memo → title, summary, actions; "Ask AI" across all notes; style rewrite | Cloud | A second daily loop for the same engine: note-to-self |
| **Viska, WhisperNotes** (on-device indies) | $4.99–6.99 one-time, whisper + Llama 3.2 | No speaker identification; WhisperNotes is iOS-only | The segment review names exactly two gaps: Android, and speaker ID. Verbale has both |
| **Android AICore** | Gemini Nano 4 via ML Kit: summarisation, and speech recognition with an "advanced" mode | Advanced mode is Pixel 10 only; it is Google's model | A platform floor is coming for basic transcription. Do not build on it — it breaks the promise |

**Four takeaways.**

- The recurring complaint across every review is the same triad: accuracy on accents and jargon,
  speaker labels that mean nothing, and summaries that confidently invent. Verbale's refusal
  design is the only direct answer to the third in the category. Say so in the listing.
- Everyone with a desktop app shipped it in 2026 without a bot (Plaud Desktop, Granola). The
  roadmap's "online capture is a non-goal" is right for the phone and wrong for the desktop, where
  loopback capture needs no bot and no cloud.
- The on-device indies price at $5–7 one-time. Plaud and Otter charge $100–200 a year. Verbale sits
  in between and has to justify the subscription with things a one-time app cannot ship: languages,
  a writer model, and memory across meetings.
- Nobody offline has persistent speakers. It is the feature reviewers most want, the one Pixel
  explicitly does not do, and the one Verbale's existing CAM++ embeddings make cheap.

---

## 2. Improve what exists

### 2.1 Accuracy — the engine

| # | Change | Why | Evidence | Effort |
|---|---|---|---|---|
| 1 | **Replace whisper-base as the English engine.** Put Parakeet-TDT-0.6B-v3 and Moonshine v2 behind `AsrEngine`, score both with `eval.run`, ship the winner | AMI: whisper-base 29.7%, whisper-small 26.6% *(measured here)*. Parakeet reports ~16% on AMI in published configurations *(published)*; Moonshine claims large-v3 parity at 245M params *(published, vendor)*. Transducer/CTC decoders cannot loop the same sentence eleven times — the whisper failure mode from the Bengali meeting is structurally absent | sherpa-onnx already vendored; Parakeet has an Android APK path; factory, chunker and normaliser exist | **S** to measure, **M** to ship. Parakeet int8 is ~600 MB, so it may be the Pro English engine with whisper-base as the free floor |
| 2 | **Add IndicConformer-600M as a third engine.** Route `bn`, `ta`, `te`, `mr`… to it once each is measured against a corrected truth transcript | 22 languages, MIT, ONNX, CTC + RNNT, Hindi WER 13.2 on Vaani *(published)*. Bengali scored 0% Bengali script on all three shipped engines *(measured here)*. Qwen3-ASR's 30-language list does not include Bengali *(published)* | Language-ID gating already exists; the picker reads `asr_languages.cpp`; the "NOT ENGLISH" state keeps the audio for re-runs | **M**. Per-language 120M variants at ~130 MB int8 fit a per-language download *(published)* |
| 3 | **Tune the VAD for quiet phone capture, and try speech enhancement before it** | Our own finding: Silero is the level-sensitive stage; attenuating AMI 26 dB halved utterances *(measured here)*. Real phone speech sits at −31.5 dBFS p99.5 vs AMI −23.2 | sherpa-onnx ships GTCRN enhancement; the harness scores it in one run | **S** to measure |
| 4 | **Diarization: overlap and name inference** | DER 18.3% with overlap excluded *(measured here)*. Roadmap already lists transcript name inference ("Priya, can you take the deck?") | pyannote-seg-3.0 is overlap-aware; the exclusion is in our scorer | **M** |
| 5 | **Grammar-constrained narration.** Use llama.cpp GBNF / JSON-schema sampling for the reduce step | `summarize.ts` carries defence code for "the model copied the shape out of the prompt" — a whole bug class that constrained decoding removes | llama.cpp supports it natively; the prompt strings are already shared C++ | **S** |
| 6 | **Evaluate a newer writer model** (Qwen3-1.7B, Gemma 3 4B, Llama 3.2 3B at Q4_K_M) — after the slice-3 MOM judge exists | Qwen2.5-1.5B is a 2024 model; the map/reduce prompts are model-tuned, so a swap needs the judge first *(estimate)* | Eval slice 3 needs 20 hand-labelled items from you | **M**, gated |
| 7 | **Hallucination guards beyond language:** n-gram repetition collapse, compression-ratio gate, and **per-utterance confidence surfaced in the UI** (low-confidence words dimmed) | The eleven-times sentence is detectable by a two-line check. Nobody in the category shows confidence; it is the honest-product move | `asr_postprocess.cpp` is the place; whisper exposes token probabilities, transducers expose frame scores | **S** |

### 2.2 Speed, and perceived speed

| # | Change | Why | Evidence | Effort |
|---|---|---|---|---|
| 8 | **Two-pass transcription: live streaming model during capture, offline model after stop** | 0.68× realtime means a 60-min meeting waits 40 min *(measured here)*. Pixel's live-then-refine is the proven pattern | sherpa-onnx streaming zipformer (English) and Moonshine v2 both run on Android; this dissolves the "whisper reloads per call + no streaming VAD" blocker by not using whisper for the live pass | **L**, but it is also feature 3.3 below |
| 9 | **An honest ETA on the processing card**, from measured RTF × remaining speech | The stages already emit progress; the number that reassures is minutes left | — | **S** |

### 2.3 Trust — make the honest engine an honest interface

| # | Change | Why | Evidence | Effort |
|---|---|---|---|---|
| 10 | **Provenance: every minute links to the moment it came from.** Tap a decision → the transcript turn → play from there | This is what "minutes you'd forward without editing" means: the reader can check. Rule minutes know their source utterance; ask the LLM to cite utterance indices in the structured output | Playback and tap-to-seek exist; `edits` table hangs off the item hash | **M** |
| 11 | **Reassign a turn's speaker, split and merge turns** | Editing text exists; editing *who* does not. Wrong attribution is the top diarization complaint | Speakers screen already merges clusters | **S** |
| 12 | **A correction loop: names and terms you fix become a glossary, and the glossary biases the recogniser** | Roadmap's deferred "correction loop". whisper.cpp takes an `initial_prompt`; sherpa-onnx has contextual biasing for its transducer models (check it reaches the Parakeet path). Also hand the glossary to the narrator | Accuracy that compounds per user is a retention moat no one-time app has | **M** |

### 2.4 Output

| # | Change | Why | Evidence | Effort |
|---|---|---|---|---|
| 13 | **Meeting types** (stand-up, 1:1, client, interview, lecture, clinic visit, site walk) as prompt and section variants, auto-suggested from the transcript | Plaud sells 10,000 templates and Granola sells Recipes. On-device it is prompt text. Also the cheapest way to enter the Indian clinic-notes market (a SOAP template + glossary) | `llm_prompts.cpp` already takes a language; add a type | **S–M** |
| 14 | **DOCX export, and WhatsApp-first sharing** (a formatted message and a PDF in one tap) | Exports are MD/TXT/SRT/PDF. In India the minutes travel by WhatsApp; `LAUNCH.md` already says the link spreads that way | Share-in exists; share-out is the mirror | **S** |
| 15 | **"NOT ENGLISH" needs a next step:** "Keep it, tell me when Bengali is supported, re-run then" | The audio is already kept for exactly this; the state currently ends the story | `unsupported_language` plus the retained audio are the whole mechanism | **S** |
| 16 | **The free-tier document.** Lead the free export with the actions list and a rule-composed paragraph, never a count | August review 2.4; still the thing a free user shows a colleague | — | **S** |

### 2.5 Paper cuts seen this pass

- Library is a flat list with sort and tags; a home that says "Today: 2 meetings, 3 actions due,
  1 waiting on Priya" is the difference between a recorder and a daily-open app.
- Pro's total first-run footprint is now ~2.2 GB (114 MB + 1.1 GB writer + 972 MB Qwen3-ASR). The
  roadmap's device-tier matrix and a "what each download buys you" screen are overdue.
- The record screen has no way to mark a moment (see 3.2).
- Speakers are per-meeting rows; nothing survives to the next meeting (see 3.1).

---

## 3. New features

Ranked by value for the effort, all on-device, none needing a server.

### Tier 1 — deepen the moat

| # | Feature | What it is | Why now | Effort |
|---|---|---|---|---|
| 3.1 | **Persistent speakers ("People")** | A `people` table with a centroid voice embedding per named person. Rename Speaker 2 → Priya once; next meeting the app asks "Sounds like Priya?" and, on yes, labels her | Same CAM++ embeddings already computed for diarization; sherpa-onnx has speaker-ID extraction. No offline app does this; Pixel's labels are anonymous by design. Also makes the Actions view "who owes me" by real person | **M** |
| 3.2 | **Mark a moment** | One button on the record screen, the PiP pane, the QS tile and the notification that drops a timestamped marker. Markers become a "Highlights" section and are fed to the narrator | Plaud built hardware for this. It is a day of work here and changes what the minutes contain | **S** |
| 3.3 | **Live transcript and live speaker turns** | Streaming model during capture, offline pass after. Notes exist before you leave the room | The perceived-quality lever; halves the wait; unblocked by 2.1 #8 | **L** |
| 3.4 | **Ask your meetings, offline** | FTS retrieve → writer model answers, with citations to the turns it used. "What did we decide about pricing last week?" | The category's flagship (Otter, Voicenotes, Granola chat) — Verbale's would be the only one that never leaves the phone. Needs the writer model, so it is the Pro reason | **M** |
| 3.5 | **Indian languages, one at a time** | The IndicConformer engine from 2.1 #2, each language shipped with its number | This is the bet the company already made; this is the missing engine for the languages Qwen3 lacks | **M** |

### Tier 2 — habit and distribution

| # | Feature | What it is | Why | Effort |
|---|---|---|---|---|
| 3.6 | **Calendar-aware capture** (read-only, no account) | Read the device calendar; nudge "Sprint planning starts in 2 min — record?"; pre-title the meeting; pre-load attendee names as speaker candidates | Attendees are the best source of speaker names that exists. `CalendarContract` needs no server | **S–M** |
| 3.7 | **Consent kit** | One-tap spoken announcement ("This meeting is being recorded by Verbale"), a consent card to show the room, region defaults for all-party states | Otter is in court over exactly this; Limitless shipped a chime; Apple's call recording announces. Cheap, on-brand, screenshot-able | **S** |
| 3.8 | **Weekly digest, on-device** | A notification and page: meetings, actions done, overdue, who is waiting on whom | Habit loop on top of the streak card | **S** |
| 3.9 | **Home widget and watch start/stop** | Record + today's actions on the home screen; Wear OS tile | Granola ships Apple Watch; the QS tile is halfway there | **S–M** |
| 3.10 | **Note-to-self mode** | The same engine for personal voice memos: cleaned note, todos, no diarization. Share-in a WhatsApp voice note → a note | Voicenotes/AudioPen category; a second daily loop for zero engine work | **S** |
| 3.11 | **Privacy proof screen** | "Network calls this month: 1 licence check. Audio uploaded: 0 bytes." Plus Play Data Safety "no data collected" | August review #6; still the cheapest conversion asset for regulated buyers | **S** |

### Tier 3 — bigger bets

| # | Feature | What it is | Why | Effort |
|---|---|---|---|---|
| 3.12 | **Desktop (macOS, Windows) with the heavy tier** | Same C++ core; large models; loopback capture for online meetings without a bot | Every 2026 competitor went desktop bot-free; roadmap Phase 4; the premium tier is only real on a desktop | **L** |
| 3.13 | **Clinic notes (India)** | A meeting type, a glossary, a SOAP layout, DPDP-friendly by construction | Ambient scribe is the fastest-adopting clinical AI category; Hinglish consults are the norm and on-device is the pattern the market wants | **M** after 2.4 #13 |
| 3.14 | **Serverless sharing** | Export a meeting bundle; Nearby Share or QR between two phones; both keep the promise | Teams without a backend; on-brand | **M** |
| 3.15 | **iOS** | After Android converts. Sell languages, people and actions; Apple already gives away English transcription | Roadmap Phase 4 | **L** |

---

## 4. Monetisation notes

Benchmarks: Otter Pro ~$8–10/mo billed annually; Fireflies $10/mo; Granola $14/mo; Plaud
$99.99/yr for 1,200 min/month; on-device indies $5–7 once. India converts at 0.7% against 2.8% in
North America *(your research, `LAUNCH.md`)*.

- **Free** must be good enough to show a colleague: English (whisper-base or Moonshine), rule
  minutes, playback, editing, search. No minute caps — Plaud's caps are the opening.
- **Pro** is the things a one-time app cannot ship: the writer model, every added language, People,
  Ask-your-meetings, the heavy desktop tier. Each new Tier-1 feature above is a Pro reason.
- Consider one **one-time "lifetime" SKU** for India alongside the subscription. The on-device
  segment's buyers expect it, and 0.7% conversion says the monthly ask is the wrong shape there.
  *(estimate)*

---

## 5. What not to build

- Anything cloud, any bot, any auto-join. The lawsuit environment is the moat's fence.
- AICore / Gemini Nano as an engine. It is on-device but it is a third-party model; the promise
  says no.
- A 100-language claim. The picker's rule — a language appears when it has a number — is the
  product.
- Always-on capture. Wearables are being bought by Meta and Amazon; that is not this company.

---

## 6. A 90-day sequence

> **Amended 2026-09-05. Two decisions, and the live to-do list moved to `docs/NEXT.md`.**
>
> 1. **v1 ships English only.** Already the state of the code (`asr_languages.cpp` carries one
>    row). The Hindi and Bengali work is **post-launch**, and §2.1 #1 (the English engine swap) is
>    promoted from "improvement" to the launch bet, because English is now the entire product.
> 2. **The launch is global, not India-first** — US, Europe, Australia, Singapore, plus
>    English-medium meetings anywhere. This re-weights three things in this document: the consent
>    kit (§3.7) moves up, because all-party-consent US states and GDPR are now the operating
>    environment; persistent speakers (§3.1) acquire a biometric-data question under Illinois BIPA
>    and GDPR Article 9 that must be answered before shipping, not after; and the India-specific
>    items (clinic notes §3.13, WhatsApp-first sharing §2.4 #14, the rupee lifetime SKU §4) are
>    parked until Hindi ships.
>
> **Also superseded by evidence:** §2.1 #7 called the hallucination guards unbuilt. They are built
> and committed as of 2026-09-05, after a real Galaxy A07 meeting was nearly refused as Turkish,
> invented 43 words out of room tone, and displayed a refused meeting as permanently in flight.
> **And a gap this research missed:** the only English benchmark here is AMI, which is British and
> European speech from 2005. A global English launch has zero measurement on American, Australian,
> Indian or Singaporean accents. `docs/NEXT.md` item 4.

**Weeks 1–2 — measure.** Parakeet and Moonshine in the harness — now pre-launch, since English
carries the product alone. Mark-a-moment shipped. Repetition guard shipped. The refused-meeting
next step (§2.4 #15) shipped, because English-only means more users meet the refusal.
*Deferred to post-launch: IndicConformer on the Bengali meeting, and the corrected Hinglish truth
transcript — still the one input nobody but you can supply, and still first in the queue after.*

**Month 1 — ship the engine.** The winning English engine. "NOT ENGLISH" follow-through. Consent
kit. Meeting types. DOCX and WhatsApp share. Grammar-constrained narration.

**Month 2 — memory.** People (persistent speakers). Calendar-aware capture. Ask-your-meetings.
The MOM judge (slice 3) so the writer model can be swapped with a number.

**Month 3 — live.** Two-pass live transcript. Weekly digest. Widget.

**After.** Desktop heavy tier with bot-free online capture; iOS; clinic notes.

---

## Sources

- Otter: [Fast Company on the knowledge engine](https://www.fastcompany.com/91532774/otter-wants-its-ai-to-unlock-information-from-all-your-business-meetings), [Otter features](https://otter.ai/features), [lawsuit status](https://basilai.app/articles/2026-06-21-in-re-otter-ai-privacy-litigation-may-2026-hearing-explained.html), [order explained](https://www.recordinglaw.com/news/otter-ai-wiretap-lawsuit-explained/)
- Plaud: [NotePin S at CES 2026](https://www.plaud.ai/blogs/articles/plaud-at-ces-2026-when-smart-note-taking-steals-the-show), [Note Pro review](https://www.plaud.ai/blogs/articles/plaud-note-pro-review-is-it-worth-buying-in-2026), [desktop app](https://techcrunch.com/snippet/3079694/plaud-has-a-new-ai-pin-and-a-software-notetaker), [Play reviews](https://play.google.com/store/apps/details?id=ai.plaud.android.plaud)
- Granola: [updates](https://www.granola.ai/updates/whats-new-2026-01-16), [Android launch](https://zackproser.com/blog/granola-android-launch-2026), [review](https://www.feisworld.com/blog/granola-ai-review), [pricing](https://www.granola.ai/blog/meeting-note-tool-pricing-granola-vs-fireflies-fathom-otter)
- Pixel Recorder: [speaker labels research](https://research.google/blog/who-said-what-recorders-on-device-solution-for-labeling-speakers/), [speaker labels help](https://support.google.com/pixelphone/answer/16269004), [features](https://www.bgr.com/2184589/cool-features-google-pixel-recorder-app/)
- Apple: [Notes with Apple Intelligence](https://support.apple.com/guide/iphone/use-apple-intelligence-in-notes-iph59143007d/ios), [iOS 26 call recording](https://www.logicweb.com/how-to-use-the-ios-26-phone-call-recording-feature-a-complete-guide/)
- Samsung: [Transcript Assist](https://www.samsung.com/uk/support/mobile-devices/how-to-use-galaxy-ai-transcript-assist/)
- Wearables: [Limitless vs Bee](https://www.umevo.ai/blogs/ume-all-posts/limitless-pendant-vs-bee-ai-which-always-on-wearable-recorder-is-best), [2026 roundup](https://www.layer3labs.io/guides/best-ai-wearable-pendants-2026)
- On-device segment: [best offline transcription apps 2026](https://viskalocal.com/blog/best-offline-transcription-apps-2026.html)
- Android platform: [on-device inference blog, July 2026](https://android-developers.googleblog.com/2026/07/android-on-device-inference.html), [Gemini Nano](https://developer.android.com/ai/gemini-nano)
- Models: [IndicConformer-600M](https://huggingface.co/ai4bharat/indic-conformer-600m-multilingual), [IndicConformer ONNX](https://huggingface.co/OpenVoiceOS/ai4bharat-indicconformer-ml-onnx), [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR), [Qwen3-ASR in sherpa](https://k2-fsa.github.io/sherpa/onnx/qwen3-asr/index.html), [Parakeet TDT 0.6B v3 ONNX](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx), [Parakeet in sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html), [on-device streaming ASR paper](https://arxiv.org/abs/2604.14493), [Moonshine v2](https://arxiv.org/abs/2602.12241), [Moonshine repo](https://github.com/moonshine-ai/moonshine), [sherpa-onnx speaker ID](https://k2-fsa.github.io/sherpa/onnx/speaker-identification/index.html), [sherpa-onnx diarization](https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/index.html), [local STT 2026](https://www.onresonant.com/resources/local-stt-models-2026), [small LLMs on phones](https://www.promptquorum.com/power-local-llm/mobile-llm-models-phi4-gemma-smollm)
- India: [AI4Bharat ASR](https://ai4bharat.iitm.ac.in/areas/asr), [Sarvam stack](https://explainx.ai/blog/sarvam-ai-capabilities-api-models-guide-2026), [ambient scribes for Indian doctors](https://www.cellassist.ai/guides/ai-medical-scribe-india), [on-prem pattern](https://rdp.in/gpu-mart/knowledge-base/ambient-clinical-ai-scribes-on-prem-gpu-indian-hospitals/)
- Voice-memo category: [Voicenotes vs AudioPen](https://speakwiseapp.com/blog/voicenotes-ai-vs-audiopen), [alternatives](https://www.yaps.ai/blog/voicenotes-alternative)
- Complaint themes: [why most tools still get it wrong](https://ucstrategies.com/news/best-ai-note-taking-apps-in-2026-why-most-tools-still-get-it-wrong/), [agent data reliability](https://www.aimeetings.dev/blog/best-meeting-note-takers-2026-agent-data-reliability/)
