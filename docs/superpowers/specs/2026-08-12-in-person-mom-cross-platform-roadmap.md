# In-Person MOM — Cross-Platform Roadmap (Design)

Date: 2026-08-12
Status: Draft for review
Type: Program roadmap (umbrella for multiple sub-project specs)

## 1. Vision & positioning

Make the phone (and later the desktop) the **assistant that turns any in-person conversation
into minutes you'd forward without editing** — accurate, correctly attributed, well-structured —
with **zero setup and nothing leaving the device.**

**Why in-person is the wedge (the moat):**
- Online meetings already ship with a notetaker (Otter, Fireflies, Zoom/Meet/Teams AI). Competing
  there means being the 5th-best option.
- In-person — the whiteboard session, the client lunch, the doctor's visit, the site walk, the
  hallway decision — the only competitor is "type it up from memory." The big players **structurally
  cannot** enter it: they have to be *inside the call*.
- On-device + private is a genuine, defensible differentiator, not a checkbox.

**Explicit scope decision:** online-meeting capture is a **non-goal** (see §4). The far-end of a
Meet/Teams call is not capturable on-device (Android blocks VoIP playback capture; only Zoom exposes
raw audio via a gated SDK, and even that needs a cloud bot for always-on). We are not building a
cloud service. In-person is the product.

## 2. The core architectural principle

> **Build the brain once. Each platform is a thin shell.**

The intelligence — Whisper (ASR), the diarizer (sherpa-onnx), llama.cpp (the MOM LLM), the minutes
logic — is **already C++**, and C++ runs on Android, iOS, macOS, and Windows. So:

```
            ┌─────────────────────────────────────────────┐
            │   Shared C++ core (capture-agnostic)          │
            │   PCM in → transcript + speakers + MOM out    │
            │   whisper.cpp · silero VAD · sherpa diar ·    │
            │   llama.cpp · minutes · model-tier logic      │
            └───────────────▲───────────────▲──────────────┘
                            │  C API         │
      ┌─────────────┬───────┴──────┬─────────┴──────┬─────────────┐
      │ Android     │ iOS          │ macOS          │ Windows      │
      │ (mic + UI)  │ (mic + UI)   │ (mic + UI)     │ (mic + UI)   │
      └─────────────┴──────────────┴────────────────┴─────────────┘
```

Everything hard and valuable lives in the core and is **written once, benefits all four platforms.**
Per platform, only two things differ: **audio capture** and **UI**. This is the decision that makes
cross-platform tractable instead of 4× the work — and it's why all accuracy work happens in the core.

## 3. Requirements & constraints (agreed)

- **On-device, private, no cloud, no calendar, no backend.**
- **Language:** English-primary; an unpredictable second/third language may appear → a *generalist
  multilingual* model, tuned to be excellent at English and **best-effort** on the rest. **Translate
  stays off** (faithful transcription, not English translation).
- **Models auto-tiered by device.** The user taps "download"; the app detects the device class and
  fetches the heaviest model it can run *credibly*. **Model names stay hidden** — never a user choice.
- **Speakers:** no pre-entry, no enrollment. **"Speaker 1 / 2 / 3" is the bar.** The job is
  diarization that's right out of the box. (Optional, best-effort: infer real names from the
  transcript when they're spoken — "Priya, can you take the deck?" → Speaker 3 ≈ Priya — falling
  back to "Speaker N" otherwise.)
- **Processing:** batch is fine for v1. **Live/real-time transcription is deferred** to a later phase.
- **MOM:** the on-device **LLM becomes the primary** minutes writer (owners + due dates + decisions
  + questions + summary); rule-based extraction becomes the low-RAM fallback.
- **Markets:** US / Europe / Australia / Singapore first (English-dominant business comms). India
  later.
- **Platforms:** Android (exists) → iOS / macOS → Windows. **Desktop = the premium heavy-model tier.**

## 4. Non-goals (v1)

- Online-meeting capture / meeting bots (Meet/Teams/Zoom/Slack). Platform + privacy walls; owned by
  incumbents. Zoom-on-device-SDK is a possible *later* option, not v1.
- Cloud transcription, accounts, calendar integration, backend infrastructure.
- Live/real-time in-meeting notes (later phase).
- Pre-entered participant names or required voice enrollment.

## 5. Multi-device model tiering (the "will the big model run on a small phone?" answer)

The core is **model-agnostic**: whisper.cpp / llama.cpp load a *weights file* at runtime — base /
small / medium / large are the **same code**, a different file. So supporting a bigger model costs a
small device nothing; it simply loads a smaller rung. Tiering is a *runtime file choice*, not a code
fork. We make it credible (not a guess) with four mechanisms:

1. **A model ladder** — (quantized) base → small → medium → large for ASR; small → big for the MOM
   LLM. Quantization (q5/q8) adds in-between rungs to fit devices tightly.
2. **A device→tier matrix, measured not guessed** — the eval harness runs each candidate model on
   real low/mid/high phones + desktops, recording RAM, speed (× realtime), and thermals → a lookup
   from (RAM + CPU class) → rung. This is the empirical answer to "will it run."
3. **On-device calibration** — on first run, pick a rung from the matrix, transcribe a short sample
   on *that specific device*, confirm it's fast enough, and **auto-step-down** a rung if not. Covers
   devices we never tested.
4. **A graceful floor** — worst case is smallest model + rule-based MOM. **No device is ever broken;**
   it gets its best-runnable config, and the UI is honest ("Standard on this phone — the desktop app
   runs Pro-level models").

Realistic cutoffs: **phones → base/small; desktops → medium/large.** The core never changes as we add
devices — only the matrix and the weights grow.

## 6. Phases

Sequencing is owned by engineering (per direction). Android keeps shipping improvements throughout,
since it already exists. Each phase is a sub-project that gets its own detailed spec → plan → build.

### Phase 1 — Portable core + eval harness (desktop CLI)
**Goal:** extract the engine into a **capture-agnostic, desktop-buildable** C++ core behind a stable
`extern "C"` API + a **desktop CLI**, and stand up the **accuracy benchmark**.

**What the core audit found (this shapes the plan):**
- The four inference engines (`whisper_asr`, `silero_vad`, `diarizer`, `llama_engine`) are **already
  portable** — plain path-in / struct-out C++, all heavy deps vendored as CMake submodules. Android
  coupling is thin: essentially **one file** (`cpp/jni/audionotes_jni.cpp`, needs `jni.h`), a
  hardcoded `dlopen("libonnxruntime.so")` soname (won't find macOS `.dylib`), and a few CMake lines
  (`find_library(log-lib log)`, the arm `-march` guard, the ORT-AAR dance).
- **But the end-to-end pipeline is NOT in C++ yet.** Stage sequencing, the ASR↔speaker alignment,
  the rule-based minutes (`MinutesExtractor.kt` / `src/pipeline/minutes.ts`), and the LLM map-reduce
  (`src/pipeline/summarize.ts` / `LlmModule.kt`) all live in **Kotlin/TS**. `cpp/audionotes_core.h`
  sketches a `Pipeline` facade but it is **unimplemented**. So "extract the core" is partly
  "**port the orchestration + minutes into C++**" — that is the real work, not the CMake.
- Audio is **headerless PCM16LE mono @16 kHz** (no WAV header); a desktop CLI fed a `.wav` needs a
  WAV front-end / resampler.

**Work, sliced so we can measure ASAP:**
- **1a — Minimal eval (transcript + speakers + speed).** Desktop CMake target building the core
  *without* the JNI file; a WAV/PCM front-end; a thin C++ orchestrator (VAD → ASR → diarize → align)
  behind an `extern "C"` API; a CLI. Score **WER + diarization error + × realtime/RAM** on the
  benchmark set. This alone produces most of the **device→tier matrix** (§5) and unblocks the ASR
  work.
- **1b — MOM eval.** Port the minutes (`MinutesExtractor`) + the LLM map-reduce prompts into C++ so
  the CLI emits the full MOM; add **MOM-quality scoring** vs the ideal MOM.
- **Benchmark set:** 3–5 real, English-primary (some code-switched) meetings with ground-truth
  transcript + ideal MOM.

**Unlocks (one move, three wins):** fast off-device iteration for all accuracy work; the seed of the
desktop app; the shared brain for iOS/Windows/Mac. The new `extern "C"` API becomes the stable
boundary the JNI shim occupies today — the same one iOS/Windows/Mac shells (and the eval harness)
bind to. Produces the device→tier matrix (§5).

### Phase 2 — Accuracy in the core
**Goal:** raise transcript + MOM + attribution quality, measured against Phase 1.
**Work:** tiered **multilingual Whisper** (English-optimized, no-translate) replacing base-only; the
**LLM promoted to primary MOM writer** (owners/dues; rules as fallback) — leverages the native LLM
plumbing already built; **diarization tuning** + optional **name-inference** from the transcript.
**Lands on Android immediately** (same core).

### Phase 3 — Model tiering + auto-download
**Goal:** ship the §5 tiering end-to-end.
**Work:** device capability detection (RAM + CPU) → tier; "download the best models for your phone"
flow (Wi-Fi-only, resumable, size-aware; the existing ModelManager extends to this); on-device
calibration + graceful floor; tier ladder extended from phone up to desktop-heavy.

### Phase 4+ — Platform rollout
**Goal:** put the shared brain in front of more users.
**Work:** **iOS + macOS** first (React Native already covers iOS; C++ ports cleanly; macOS can
piggyback via Catalyst) → then **Windows** (the biggest single lift: separate UI shell + toolchain,
choice deferred — RN-Windows vs Electron/Tauri vs native; core-centric design keeps it open).
Desktop unlocks the heavy-model tier.

### Later (explicitly deferred)
- Live/real-time in-meeting transcription (the current whisper-reload + no-streaming-VAD blocker —
  build on Phase 1's core once it's clean).
- Post-hoc **correction loop** (fix a name/term or a speaker label once → it sticks via a glossary /
  voice profile; accuracy compounds).
- Zoom-on-device-SDK online capture (optional, gated).

## 7. Honest scope per platform

The brain is build-once; the per-platform cost is the **shell** (capture + UI + store/signing):
- **iOS:** moderate — RN covers it, C++ ports, need iOS mic capture + native-module port + Apple
  review.
- **macOS:** cheap if iOS exists (Catalyst).
- **Windows:** the biggest single lift — different toolchain + UI shell; core builds fine (whisper/
  llama build on Windows), but capture + UI + packaging are net-new.

## 8. Success metrics (the eval harness scores these)

- **Transcript:** Word Error Rate (overall + English-only + code-switched segments).
- **Attribution:** diarization error rate; % action items with correct speaker.
- **MOM quality:** recall of true decisions/actions/questions; owner+due correctness; a rubric score
  vs the ideal MOM.
- **Performance per tier:** × realtime, peak RAM, battery/thermals — the inputs to the device→tier
  matrix.

## 9. Open decisions (to resolve during Phase 1/2)

- **Transcript script for the mother-tongue portions:** native script, romanized, or translate-to-
  English in the *transcript* (the MOM can normalize regardless). Default proposal: keep native
  script in the transcript; MOM in English.
- **Windows desktop shell:** RN-Windows vs Electron/Tauri vs native. Deferred; kept open by the
  core-centric design.
- **Name-inference in v1 or later:** best-effort transcript name-inference — ship in Phase 2 or
  defer. (Baseline "Speaker N" ships regardless.)
- **Default target languages preloaded:** English always; whether to pre-bundle any second language
  pack or purely auto-detect.
