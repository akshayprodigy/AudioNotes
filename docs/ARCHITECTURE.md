# Verbale — architecture, algorithms and audit brief

**Written 7 September 2026, for an external reviewer.** It assumes a senior engineer who has never
seen this codebase, and it is written to be *audited* rather than admired: every design decision
that could reasonably have gone the other way is stated with the evidence that decided it, and
Section 12 is a list of what is weak, unproven or knowingly deferred.

Every file path is a link into the repository. Pseudocode is given for the logic worth challenging;
it is faithful to the source but omits error plumbing, so read it as a specification of intent and
the named file as the truth.

---

## 1. What the product is

**Verbale** (`com.innocorelabs.verbale`) is an Android app that records an in-person meeting and
turns it into a transcript, speaker labels, minutes and a written summary — **entirely on the
device.** No audio leaves the phone. There is no server-side inference, and there is no account
required to use it.

The product bet is a straight line: cloud meeting recorders (Otter, Fireflies, Fathom) are built
for video calls and upload everything. In-person meetings are underserved, and they are exactly the
ones people are least willing to upload. Offline is therefore both the privacy story and the
product story.

**Scope of v1:** English only, launched globally. Hindi is built (Qwen3-ASR) but parked — see
§4.4.

**Non-goals, deliberately:** real-time transcription during capture, cloud sync, multi-device,
video, calendar integration.

---

## 2. System shape

Four layers, and the split between them is the single most important architectural fact here.

```
┌──────────────────────────────────────────────────────────────┐
│  React Native 0.86 (New Arch, Fabric, Hermes) — TypeScript   │  presentation
│  screens, navigation, library, export UI, billing UI         │
└───────────────────────────┬──────────────────────────────────┘
                            │ TurboModules (src/native/*.ts)
┌───────────────────────────▼──────────────────────────────────┐
│  Android / Kotlin                                             │  platform + orchestration
│  RecordingService · ProcessingService · ProcessingEngine      │
│  AudioDb (SQLCipher) · ModelCatalog · billing · export · PiP  │
└───────────────────────────┬──────────────────────────────────┘
                            │ JNI (cpp/jni/audionotes_jni.cpp)
┌───────────────────────────▼──────────────────────────────────┐
│  C++17 core — libaudionotes.so                                │  the algorithms
│  VAD · ASR engines · diarization · minutes · LLM              │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│  Vendored native deps                                         │
│  whisper.cpp · sherpa-onnx · llama.cpp · ONNX Runtime 1.20     │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 Why the algorithms are in C++ and not Kotlin

Portability, and it is not speculative. The same core drives a desktop CLI
([`cpp/cli/main.cpp`](cpp/cli/main.cpp)) which is what the evaluation harness scores. **Anything
measured on a laptop is the same code that runs on the phone.** A Kotlin implementation would have
meant a second copy of every rule and a benchmark that measured something the user never runs.

That discipline has a visible cost: `Minutes.kt`, `minutes.ts` and `minutes_extractor.cpp` were
once three hand-maintained copies of the same rules. Two were deleted; the JNI now calls the C++
([`nativeMinutes`](cpp/jni/audionotes_jni.cpp)), and a device test asserts byte-for-byte parity with
the TypeScript golden files.

### 2.2 Where orchestration lives, and why not in C++

[`Pipeline`](cpp/pipeline/pipeline.h) is capture-agnostic: PCM in, transcript + minutes out. It
deliberately does **no** database writes, retention, retitling or status bookkeeping. Those are app
concerns and live in [`ProcessingEngine.kt`](android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt),
because resume-by-stage needs the database and the database is the platform's.

The consequence a reviewer should check: **the CLI and Android drive the same stages but through
different code.** They are kept in step by convention and by the eval harness, not by a compiler.
This is a real risk surface — see §12.

---

## 3. The pipeline

Five stages. Each is independently skippable, and every one degrades rather than failing the
meeting.

```
  audio.pcm (16 kHz mono PCM16, headerless)
      │
      ├─ 1. VAD ─────────► speech spans          Silero VAD          ~0.01× realtime
      │
      ├─ 2. ASR ─────────► utterances            whisper.cpp base    ~0.34–0.53×
      │                    (+ language verdict)
      │
      ├─ 3. Diarization ─► speaker segments      pyannote + CAM++    ~0.64×
      │
      ├─ 4. Align ───────► utterances w/ speaker (pure function)     free
      │
      ├─ 5a. Minutes ────► decisions/actions/qs  rule-based          ~8 ms
      │
      └─ 5b. Narration ──► prose summary         Qwen2.5-1.5B        ~0.32×
```

**Total ≈ 1.5× realtime on real captured audio.** A 90-minute meeting takes roughly two hours to
process after the user presses stop. This is the product's defining performance number and it is
the strongest argument for the transcribe-during-recording work in §12.

### 3.1 Stage 1 — Voice activity detection

[`cpp/vad/silero_vad.cpp`](cpp/vad/silero_vad.cpp). Silero VAD v4 (MIT), 2.3 MB ONNX.

```
process(pcm_path, cfg):
    stream the file in 512-sample frames (32 ms at 16 kHz)   # never loads the whole file
    for each frame:
        p = silero(frame, h, c)                              # recurrent; h/c carried forward
        if p > 0.5 and not in_speech:  open a segment
        if p <= 0.5 for > 100 ms:      close it
    drop segments shorter than 250 ms                        # blips, chair scrapes
    pad each side by 30 ms                                   # do not clip word onsets
    return merged segments
```

Streaming rather than whole-file is deliberate: this is the one stage that sees every byte, and a
90-minute recording is 173 MB of PCM.

**Why VAD at all:** everything downstream is charged per second of audio. On the AMI corpus, speech
is 62–87 % of a recording, so this saves 13–38 % — and, more importantly, it stops whisper being
handed windows of pure silence, which it *fills in* (§3.2).

### 3.2 Stage 2 — Chunking, and the invented-words defect

[`cpp/asr/asr_chunker.cpp`](cpp/asr/asr_chunker.cpp). Worth an auditor's attention because it
encodes a bug that shipped.

Speech spans are packed into decode windows up to the engine's budget (30 s for whisper). The
original packing tested only the *total window length*, never the *gap between spans*. So a 0.4 s
creak in a quiet room was packed together with real speech 24 seconds later, and whisper — handed a
window that is almost entirely silence — hallucinated to fill it. Measured on
[`eval/silence.py`](eval/silence.py): **43 invented words describing a meeting that never happened.**

The fix is `kMaxMergeGapMs = 12000`, and the constant was chosen on what it *costs*, not what it
fixes:

| max gap | invented words | ES2002a WER (deletions) | ES2003a WER (deletions) |
|---|---|---|---|
| none | 43 | 29.78 % (302) | 24.86 % (224) |
| 3 000 ms | 0 | 30.95 % (335) | 25.75 % (233) |
| 8 000 ms | 0 | 30.64 % (338) | 24.96 % (225) |
| **12 000 ms** | **0** | **29.70 % (304)** | **24.86 % (224)** |

Every threshold removes the invention. Tighter ones split windows that legitimately span a pause,
and each extra boundary is a window decoded without the previous one's context, which shows up as
deleted words. 8 s "felt safer" and cost 36 real words to buy protection against gaps the corpus
does not contain. **A hypothesis about unseen failures did not outrank a measured loss.**

Windows do not overlap. Overlap would need per-engine de-duplication, and duplicated speech is a
worse failure than a clipped word.

### 3.3 Stage 2 — Transcription

[`cpp/asr/whisper_asr.cpp`](cpp/asr/whisper_asr.cpp), whisper.cpp with `ggml-base-q5_1` (60 MB).
Two threads is optimal on a Pixel; more contends with the little cores.

### 3.4 Stage 2 — Language detection and **refusal**

This is the safety mechanism most worth auditing, because it exists to prevent a failure that is
invisible to the victim.

**The failure:** a Bengali meeting came back as fluent, confident, *invented* English, summarised
into minutes that read as correct to somebody who had been in the room. whisper's tokenizer knows
~99 languages; the product transcribes one. Asking whisper for a language it knows but we have not
measured produces plausible fiction.

```
transcribe(pcm, segments):
    chunks = makeChunks(segments, 30_000 ms)

    # Detect over up to 5 windows, not one.
    heard = []
    for chunk in first 5 chunks:
        code, p = whisper_lang_auto_detect(chunk)
        heard.append((code, p))

    verdict = tallyLanguage(heard)          # majority vote + mean confidence of agreeing windows
    if shouldRefuse(verdict, min_confidence):
        return AsrRun{ unsupported_language = true, detected_language = verdict.code }
        # NOTHING downstream runs. No transcript, no minutes, above all no narration.

    for each chunk: decode and emit utterances
```

Two properties are load-bearing:

**Five windows, not one.** A single 30-second sample of a *real English meeting* was heard as
Turkish at **p = 0.88** — past any threshold that would still catch the languages this exists to
catch — because the opening of a meeting is greetings, cross-talk and a microphone settling.
[`shouldRefuse`](cpp/asr/asr_languages.h) therefore requires *agreement*, not just confidence: a
strict majority of the windows that answered must have heard the same unsupported language.

**Ties resolve to "supported".** The two errors are not symmetric. Wrongly refusing costs somebody
the meeting they just recorded; wrongly transcribing costs a reprocess once the language is
supported.

**The escape hatch.** A user can overrule the refusal ("Transcribe it anyway"). It is per-run, not
a setting — a build that could switch the guarantee off globally would not have the guarantee. The
override stamps `transcribe_forced_at` and `forced_from_language`, and the resulting meeting carries
a non-dismissible banner **for life**, which travels into every PDF and Markdown export. The person
who forced it knew; the person reading it three weeks later did not.

### 3.5 Stage 3 — Diarization (who spoke)

[`cpp/diar/diarizer.cpp`](cpp/diar/diarizer.cpp), sherpa-onnx: **pyannote segmentation 3.0** (6 MB)
finds speaker-change boundaries, **3D-Speaker CAM++** (28 MB) embeds each segment's voice, and
agglomerative clustering groups them.

```
process(pcm_path, vad_spans, window_ms):
    padded = padAndMerge(vad_spans, pad = 500 ms, total_ms)
    samples = readSpans(pcm_path, padded)        # seek per span; silence never read
    segments = sherpa_diarize(samples)           # segment → embed → cluster, threshold 1.0
    return toOriginalTimeline(segments, padded)  # concatenated time → real recording time
```

**The 500 ms padding is not cosmetic.** Diarizing bare VAD spans butts one speaker's turn straight
against the next, which presents pyannote with a speaker change that never happened *and* removes
the silence it reads as a boundary. Measured on AMI ES2003a: DER 16.4 % → 24.1 %, attribution
95.8 % → 84.7 %. Padding restores the context. 1000 ms was tried and was worse (ES2003a attribution
91.0 % → 87.3 %), so 500 is a peak, not a direction.

**The clustering threshold is 1.0**, swept over four AMI meetings, two held out (DER 46.2 → 15.9,
33.3 → 8.5, 71.9 → 30.9). sherpa's default of 0.5 split four-speaker meetings into 28–101 clusters.
It is a genuine peak: 1.2 over-merges and lands worse than 0.5.

**`toOriginalTimeline` splits a segment that straddles a join.** In concatenated time two halves are
adjacent; in the recording they can be minutes apart, and emitting one segment across the gap would
attribute every silence — and anyone who spoke in it — to whoever was talking either side.

### 3.6 Stage 4 — Speaker alignment

[`alignSpeakers`](cpp/pipeline/pipeline.h), a pure function.

```
for each utterance u:
    for each diarization segment d:
        overlap[d.speaker] += temporal_overlap(u, d)
    u.speaker = argmax(overlap)   or   -1 if no overlap at all
```

Max-summed-overlap, not midpoint or majority-frame. Speaker ids are then renumbered "Speaker 1..K"
over the clusters that actually own utterances.

### 3.7 Stage 5a — Rule-based minutes

[`cpp/minutes/minutes_extractor.cpp`](cpp/minutes/minutes_extractor.cpp), mirrored by
[`src/pipeline/minutes.ts`](src/pipeline/minutes.ts). Deterministic, no model, ~8 ms. **This is the
free tier's floor and it is a real product, not a fallback.**

Utterances are split into sentences and classified by regex:

- **Decision** — `we decided | we agreed | agreed to | let's go with | signed off | approved | …`
- **Action** — first-person commitment (`I'll`, `we need to`), assignment (`can you`, `please`),
  obligation (`must`, `has to`, `follow-up`), or an imperative verb opening the sentence
- **Question** — ends in `?`, or opens with `what/why/how/when/…` and is under 160 characters

Owner attribution: a `Name will/to/should` pattern wins; failing that, a first-person commitment is
attributed to the speaker who said it; an assignment with no name becomes `Unassigned`.
Classification priority is decision → action → question, and items are de-duplicated on normalised
text.

**Every item quotes something that was said.** Measured `invented = 0` across four AMI fixtures.
That property is why the LLM does not replace these (§3.8).

### 3.8 Stage 5b — Narration

[`cpp/minutes/llm_minutes.cpp`](cpp/minutes/llm_minutes.cpp) + llama.cpp, **Qwen2.5-1.5B-Instruct
Q4_K_M** (1.1 GB), greedy sampling, 8192 context.

```
lines   = transcriptLines(utterances, speakers)
chunks  = chunkTranscript(lines, max_chars = 6000)

digests = [digestPrompt(c) for c in chunks]        # prose, per chunk, committed to llm_notes
while joined(digests) does not fit:
    digests = [condensePrompt(g) for g in groups(digests)]

narrative = narrativePrompt(digests)               # progressive condensation
summary   = summaryPrompt(narrative)
headline  = headlinePrompt(summary)
```

Three decisions here are worth challenging, and each has a measurement behind it:

**The LLM does not replace the rule minutes; it writes prose on top.** It used to replace them
wholesale. The rules are extractive and quote real speech; a 1.5B model asked for structured items
invents them.

**Nothing asks for JSON.** Measured 2026-08-26 on a real recording: with `summary` as a field inside
a JSON schema, Qwen2.5-1.5B answered *"No decisions were explicitly stated."* — commentary on its
own extraction, contradicted by the two actions it had just listed. The same weights given a plain
prose prompt wrote four specific, true sentences.

**Progressive condensation**, narrative → summary → headline, rather than three independent
generations. Only the first pays a full-transcript prefill (the expensive part on a phone), and the
three cannot contradict each other because each condenses the one above.

**Greedy sampling is not a default, it is a requirement.** Minutes that differ between two runs of
the same recording are not minutes.

Each chunk's digest is committed to `llm_notes` as it lands, so a process killed at chunk 5 of 9
resumes at 5.

---

## 4. Models: what, why, and what it costs

Nothing is in the APK. All weights are fetched on first run, **sha256-verified against a hash
computed from the exact bytes at the URL**, and renamed into place per file
([`ModelCatalog.kt`](android/app/src/main/java/com/innocorelabs/verbale/data/ModelCatalog.kt)).

| id | model | size | licence | role |
|---|---|---|---|---|
| `onnxruntime-lib` | ONNX Runtime 1.20 | 17.6 MB | MIT | inference engine (kept out of the APK) |
| `silero-vad` | Silero VAD v4 | 2.3 MB | MIT | speech detection |
| `whisper-base` | Whisper base q5_1 | 59.7 MB | MIT (weights: MIT) | transcription (default) |
| `whisper-small` | Whisper small q5_1 | 190 MB | MIT | Pro: accents, crosstalk |
| `diar-seg` | pyannote segmentation 3.0 | 6.0 MB | MIT (sherpa export) | speaker-change detection |
| `diar-emb` | 3D-Speaker CAM++ zh_en | 28.3 MB | Apache-2.0 | voice embedding |
| `llm-qwen` | Qwen2.5-1.5B-Instruct Q4_K_M | 1.12 GB | Apache-2.0 | prose minutes |
| `qwen3-asr` | Qwen3-ASR 0.6B int8 | 972 MB | Apache-2.0 | Hindi — **built, not offered** |

**Licence position.** [`src/legal/notices.ts`](src/legal/notices.ts) carries the **full verbatim
text** of every licence, read off the `LICENSE` files vendored in this repository rather than copied
from a website, covering **19 components** across MIT, Apache-2.0, BSD-3-Clause and OFL-1.1 — the
four that require their text to travel with the software. Naming a licence does not discharge that
obligation, so the text ships and is reachable from Settings.

Models: Silero VAD (MIT), Whisper (MIT), pyannote segmentation 3.0 (MIT, © 2023 Hervé Bredin),
3D-Speaker CAM++ (Apache-2.0), Qwen2.5-1.5B-Instruct (Apache-2.0). Native libraries: whisper.cpp,
llama.cpp, ggml, ONNX Runtime, nlohmann/json (MIT), sherpa-onnx (Apache-2.0), SQLCipher
(BSD-3-Clause). All permit commercial redistribution.

**No lawyer has reviewed this.** It is an engineer's reading of each upstream `LICENSE`, and §12
lists it as an open risk. The specific thing worth a professional eye is model weights, where the
licence on a repository and the licence on the weights are not always the same document.

### 4.1 Why CAM++ for embeddings

Measured on a Pixel 7 Pro over a 189 s fixture, each in a fresh process
([`DiarEmbeddingBench`](android/app/src/androidTest/java/com/innocorelabs/verbale/DiarEmbeddingBench.kt)):

| model | time | realtime | size |
|---|---|---|---|
| **CAM++ zh_en (chosen)** | **44.0 s** | **0.23×** | **27.0 MB** |
| WeSpeaker CAM++ en | 47.2 s | 0.25× | 29.3 MB |
| ERes2Net zh-cn (previous) | 87.7 s | 0.46× | 37.8 MB |
| WeSpeaker ResNet34_LM en | 104.1 s | 0.55× | 25.3 MB |

2× faster and 10.8 MB smaller than what it replaced. **Honest caveat, recorded in the source:** all
four scored identically on the two-voice fixture, which is too easy a case to separate them. The
choice rests on cost and language coverage, **not on measured diarization accuracy.**

### 4.2 Why Qwen2.5-1.5B

Apache-2.0 (so it can ship), 1.1 GB at Q4_K_M (the largest a mid-range phone will tolerate), and
instruction-tuned. It is a "safe, widely available default" rather than the outcome of a bake-off —
an auditor should read that as an *unvalidated* choice.

### 4.3 Why whisper and not a newer English model

Parakeet-TDT and Moonshine are vendored and reachable behind `--asr-engine`, purely to be measured.
Neither has a routing entry, and the rule in [`asr_factory.cpp`](cpp/asr/asr_factory.cpp) is
explicit: **a language routes to an engine once somebody has scored it.**

### 4.4 Why Qwen3-ASR is built but switched off

On a real Hindi/English meeting it read 69.8 % Devanagari against whisper-base's 4.1 %, and 1,205
words against 976. But it is 972 MB and there is **script evidence without an accuracy number**.
Hindi is not an offered language, nothing routes to Qwen, and asking somebody to download 972 MB
that cannot run is worse than not mentioning it. The row, hashes and mirror all stay.

---

## 5. Capture

[`RecordingService.kt`](android/app/src/main/java/com/innocorelabs/verbale/pipeline/RecordingService.kt)
— a foreground service (`microphone` type) holding a `PARTIAL_WAKE_LOCK`.

- **16 kHz mono PCM16**, headerless, written straight to disk through a 64 KB buffer
- **`MediaRecorder.AudioSource.UNPROCESSED`**, falling back to `VOICE_RECOGNITION`

That audio source choice is load-bearing twice over. It was chosen for ASR quality — neither source
applies the acoustic echo cancellation `VOICE_COMMUNICATION` would. **A second feature now depends
on it**: the consent announcement (§8) is played through the speaker *while the microphone is live*
and must be recorded. If the source ever changes, that feature silently stops producing evidence. A
comment in the service says so.

Capture survives the app being backgrounded, the screen locking, and Picture-in-Picture. A recording
can be started and stopped from a Quick Settings tile or the PiP window without the RN layer being
alive; stopping from either processes the meeting headlessly and posts a "Notes ready" notification.

---

## 6. Processing, resume and cancellation

[`ProcessingService`](android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingService.kt)
is a foreground service (`dataSync`). Processing a 90-minute meeting takes hours, and Android will
kill a background process long before that.

**Resume is by persisted rows, not by status.** Status advances when a stage *starts*, so a process
killed mid-stage leaves status ahead of what was actually committed.

```
remaining(state):
    if not hasSegments and status != 'captured':
        return []                       # VAD ran and found no speech — terminal, not resumable
    stages = []
    if not hasSegments:   stages += VAD
    if not hasUtterances: stages += ASR
    if not hasSpeakers:   stages += DIARIZE
    if not hasNarrative:  stages += NARRATE
    return stages
```

Rule-based minutes are deliberately **not** a stage: they cost 8 ms and re-running them is cheaper
than deciding whether to.

Cancellation is polled *between ASR chunks*, not only between stages — ASR is minutes long, and a
between-stages-only check would leave a cancel unanswered.

`recoverOrphanedRecordings()` runs at startup and rescues meetings stranded in `recording` by a
process kill: rows with real audio (> 32 KB, ~1 s) are promoted to `captured`, the rest marked
`error` so they stop looking live.

---

## 7. Data model

SQLCipher, key in the Android Keystore. Declared in `AudioDb.SCHEMA`;
[`src/db/schema.ts`](src/db/schema.ts) is a readable copy that **nothing imports** and which must be
kept in step by hand — a rule the file states and which has been broken at least once.

| table | holds |
|---|---|
| `meetings` | id, title, timing, language, status, tier, audio path/retention, archive, summary line, override stamps, consent stamp, diarization skip reason |
| `utterances` | transcript, one row per utterance, FK speaker |
| `speakers` | cluster label → display name |
| `minutes` | kind (`summary`/`decision`/`action`/`question`), content, source (`rule`/`llm`) |
| `segments` | VAD spans, so ASR can resume without re-running VAD |
| `models` | what is installed, with hashes |
| `llm_notes` | per-chunk narration checkpoints |
| `action_done` | ticked actions, **keyed by a hash of the item text** |
| `edits` | user rewrites, as a **side table** |
| `network_events` | the privacy ledger (§8) |
| `tags` | many-to-many labels |

Two of these are worth an auditor's attention:

**`action_done` is keyed by text hash, not row id.** Minutes rows are deleted and re-inserted on
every reprocess; a row-id key would silently untick everything the user had worked through.

**`edits` is a side table rather than an UPDATE.** Rewriting minute text in place would move the
`action_done` key and untick the item — so the original row is left untouched, reprocessing
overwrites only what it owns, and an edit is reverted by deleting one row.

Schema changes after release go through an additive `ADDED_COLUMNS` list applied on open, because
`CREATE TABLE IF NOT EXISTS` is a no-op against an existing table.

---

## 8. Privacy, and how it is enforced rather than asserted

The claim is "no audio leaves the phone". It is enforced three ways.

**A network ledger.** Every egress writes a `network_events` row: kind, host, bytes sent, bytes
received. [`summary.ts`](src/privacy/summary.ts) derives the privacy screen from that table and
nothing else. `NetworkKind` is `'licence' | 'models' | 'crash'` — **there is deliberately no
`'audio'` member**, so "audio uploaded: 0 bytes" is a consequence of the type system rather than a
number printed on a screen.

**A CI grep guard.** [`scripts/check-network-egress.py`](scripts/check-network-egress.py) fails the
build if a network call appears outside four registered call sites. Nothing a compiler checks can
express "this app has four network call sites"; a grep can.

**Honest about what it cannot count.** Play Billing's own traffic is not interceptable and the
screen says so rather than under-reporting. Header bytes are excluded, with a footnote. A dropped
ledger write increments a drop counter so a failure can never read as an undercount.

The three egress sites are: licence verification, model downloads, and (opt-in) crash reporting.

### 8.1 The consent kit

All-party-consent US states and GDPR are the operating environment for a global launch, and Otter
is in a consolidated wiretap class action over exactly this.

A short bundled clip plays through the speaker *immediately after capture starts*, so the microphone
records it: *"This meeting is being recorded by Verbale. The recording stays on this phone."* It
lands as the first seconds of the audio and the first line of the transcript. **The recording
carries its own proof that the room was told**, and that proof travels with an exported file. A
consent flag in a local database proves nothing to anyone off the phone.

A bundled clip, not TTS: Google's TTS synthesises **over the network**, which would put a hole in
the claim the privacy screen is built to make.

The meeting is stamped `announced_at` **only on confirmed playback completion**, and only if the
clip is then *found in the recording*: [`AnnouncementVerifier`](android/app/src/main/java/com/innocorelabs/verbale/pipeline/AnnouncementVerifier.kt)
runs normalised cross-correlation against the first seconds of captured audio and also checks it was
loud enough to be evidence. On six real recordings the clip was present in five (peak-over-background
2.58–9.91) but in three of those it arrived so far under the room that no transcript would carry it.
An app that reported "the room was told" because it *tried* would be worse than one with no
announcement at all.

---

## 9. Billing

Google Play Billing only. Licences are an **offline-verifiable signed token**, not a server lookup:

```
<base64url(payload)>.<base64url(signature)>      payload = ASCII k=v pairs, ';' separated
signature = SHA256withECDSA (P-256)
```

Not a JWT: no parser dependency, identical behaviour on the JVM (where the tests run) and Android,
and the desktop build will have to verify the same token. The device checks the signature itself,
so **an offline app stays licensed offline**. A token is rejected if malformed, wrongly signed, of
an unknown version, or issued for another device.

The trial clock uses `SystemClock.elapsedRealtime` plus a stored floor rather than `Date.now()`,
because winding the phone back a week is otherwise the whole attack.

Free tier gets rule-based minutes; Pro adds prose narration and whisper-small.

---

## 10. Evaluation

[`eval/`](eval/) drives the desktop CLI over fixtures and scores it. **The scored binary is the same
core the phone runs.**

| metric | definition |
|---|---|
| **WER** | word error rate after normalisation |
| **DER** | missed + false alarm + confusion over scored reference speech |
| **Attribution** | fraction of utterances given the right speaker |
| **Invented** | minute items quoting nothing that was said — target 0 |
| ×realtime, peak RSS | cost |

[`der.py`](eval/metrics/der.py) states three conventions explicitly, each of which changes the
number materially: **Hungarian optimal label mapping** (cluster ids are arbitrary; skipping this
scores a perfect-but-relabelled result as 100 % wrong), a **250 ms collar** around every reference
boundary, and **overlapping reference speech excluded with the excluded duration reported** — the
pipeline assigns one speaker per utterance and cannot represent overlap, so scoring it would just
accumulate unavoidable error, and dropping it silently would flatter the result.

**Corpora:** four AMI meetings (CC BY 4.0) plus six EdAcc conversations for accent coverage. AMI is
2000s meeting-room audio and is explicitly *a regression detector, not evidence the product works
for phone capture.*

### 10.1 Current numbers

| fixture | WER | DER | attribution |
|---|---|---|---|
| ES2002a | 29.7 % | 23.4 % | 91.4 % |
| ES2002b | 26.9 % | 6.8 % | 93.8 % |
| IS1000a | 35.6 % | 30.9 % | 77.5 % |
| ES2003a | 24.9 % | 18.8 % | 91.0 % |
| **mean** | | **20.0 %** | **88.4 %** |

Accent sweep (EdAcc): **WER 23.3–30.2 %** across American, Scottish, Indian, Kenyan, Southern London
and Nigerian — under seven points end to end, **no accent falls off a cliff.** Scottish is *not* the
hard case (23.4 %, tied with American). The real finding is **Indian English at 79.1 % attribution**
— words right, speaker wrong, which is diarization and not ASR.

### 10.2 Tests and gates

- **C++**: 14 ctest targets — chunker, language policy, span mapping, speaker matching, minutes
  goldens, UTF-8, cancellation, C ABI
- **JVM**: Kotlin unit tests (resume planning, memory budget, ledger, licence)
- **JS**: 196 jest tests
- **Device**: 16 instrumentation tests on real hardware via
  [`scripts/device-verify.sh`](scripts/device-verify.sh) — this is the gate that catches JNI
  signature drift, which fails at *runtime*, not compile time
- **Grep guards as CI**: engine encapsulation, network egress, diarization constants

> ⚠️ **Never run `./gradlew connectedDebugAndroidTest` directly.** It uninstalls the app, taking the
> downloaded models and the recordings database with it. `npm run test:device` installs with `-r`.

---

## 11. A worked example, end to end

```
1. User taps record.
   RecordingService starts (foreground, microphone), takes a wake lock, opens
   AudioRecord(UNPROCESSED, 16 kHz, mono, PCM16). A meeting row is inserted with
   status='recording' and its audio_path known up front.

2. First statement after startRecording(): play the consent clip through the speaker.
   A 12 s in-memory prefix of captured audio is kept for the verifier.

3. User stops (app, notification, PiP or Quick Settings tile).
   Service writes duration, sets status='captured', releases the wake lock.
   AnnouncementVerifier cross-correlates the prefix; stamps announced_at only if the
   clip is found AND was loud enough.

4. ProcessingService starts. ResumePlan.remaining() → [VAD, ASR, DIARIZE, NARRATE].

5. VAD  → segments rows,  status='vad'
6. ASR  → 5-window language vote. If refused: status='unsupported_language', STOP.
          Otherwise utterances rows, status='asr'
7. DIARIZE → DiarBudget checks free memory against the meeting's padded speech.
             Fits  → diarize whole, speakers rows, status='diarized'
             Not   → skip, store diar_skipped_reason, meeting continues
8. MINUTES  → rule extraction over utterances (always; 8 ms)
9. NARRATE  → chunk → digest → condense → narrative → summary → headline,
              each chunk checkpointed to llm_notes. Retitle from the transcript.
10. status='done'. "Notes ready" notification. Audio retained per policy.
```

---

## 12. What is weak — the auditor's list

Written by the engineer who built it. This is where review effort is best spent.

### High

**The 90-minute *capture* path has never been run.** Every long-recording measurement is an
*imported* file. Disk growth, wake-lock survival, service longevity and OEM battery managers over
90 minutes of real capture are **unverified**, and the founder reports 60–90 minutes is an ordinary
meeting length. This is the top risk.

**Processing takes about as long as the meeting did** (~1.5× realtime; ~2 hours for 90 minutes).
Nothing in the product hides this. Running ASR *during* capture would remove ~0.53× of it and is
the highest-value unbuilt work; it is blocked on whisper model reload per chunk and the absence of a
streaming VAD.

**One phone.** Almost every measurement is a Pixel 7 Pro (12 GB). A single session on a Galaxy A07
produced three production bugs — English nearly refused as Turkish, 43 words invented from room
tone, and a refused state displayed as in-flight. Cheap-phone coverage is deferred by explicit
decision and remains the largest unknown.

**Diarization is the accuracy weak point.** IS1000a scores DER 30.9 % and Indian English 79.1 %
attribution. Windowing was built to bound its memory and shelved for costing 6 DER points
([`spec`](docs/superpowers/specs/2026-09-06-windowed-diarization-design.md)); the memory is handled
by refusing the meeting instead. The next attempt should be per-segment embeddings clustered
globally.

**No CI.** There is no `.github/workflows`. Every gate above is run by hand.

### Medium

**Two orchestrators.** `Pipeline` (C++, drives the CLI and the eval) and `ProcessingEngine.kt`
(drives the phone) implement the same stage sequence separately. They are kept in step by
convention. A divergence would mean the measured numbers describe something the user does not run.

**`src/db/schema.ts` is a hand-maintained copy** of a schema nothing enforces. It has drifted at
least once.

**Model choice is under-validated.** Qwen2.5-1.5B was picked as "a safe default", not from a
bake-off. CAM++ was chosen on speed and size, with the source noting the accuracy fixture was too
easy to separate the candidates.

**Licence review.** Nineteen components are catalogued with verbatim licence text
([`src/legal/notices.ts`](src/legal/notices.ts)) and all permit commercial redistribution by an
engineer's reading. No lawyer has looked at it. Model weights are the part worth professional
review: a repository's licence and its weights' licence are not always the same document.

**The multi-window diarization path has no automated test.** It is off by default, so this is latent
rather than live — but it is reachable by a flag and by any future decision to re-enable it.

### Low / accepted

- Utterances carry exactly one speaker, so **overlapping speech cannot be represented**. The eval
  excludes it and says so.
- The shipped consent clip is **synthesised**, and whisper hears "Verbale" as "Verbal". It must be
  replaced with a human recording before launch.
- The diarization memory guard's peak-multiplier constant (8×) comes from **one measurement on one
  phone** and deliberately over-estimates.
- Windows in the ASR chunker do not overlap, so a word split across a boundary can be lost. Judged
  the lesser evil against duplication; no fixture demonstrates the loss.

---

## 13. Reading order for a reviewer

| to understand | read |
|---|---|
| the whole pipeline | [`cpp/pipeline/pipeline.cpp`](cpp/pipeline/pipeline.cpp) |
| what the phone actually runs | [`ProcessingEngine.kt`](android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingEngine.kt) |
| the refusal guarantee | [`cpp/asr/asr_languages.h`](cpp/asr/asr_languages.h), [`whisper_asr.cpp`](cpp/asr/whisper_asr.cpp) |
| the invented-words defect | [`cpp/asr/asr_chunker.h`](cpp/asr/asr_chunker.h) |
| diarization timeline maths | [`cpp/diar/span_map.h`](cpp/diar/span_map.h) |
| what the free tier guarantees | [`cpp/minutes/minutes_extractor.cpp`](cpp/minutes/minutes_extractor.cpp) |
| why the LLM is shaped as it is | [`cpp/minutes/llm_minutes.h`](cpp/minutes/llm_minutes.h) |
| the privacy claim | [`src/privacy/summary.ts`](src/privacy/summary.ts), [`scripts/check-network-egress.py`](scripts/check-network-egress.py) |
| how anything is measured | [`eval/README.md`](eval/README.md), [`eval/metrics/der.py`](eval/metrics/der.py) |
| what is left before launch | [`docs/NEXT.md`](docs/NEXT.md) |

Design decisions are recorded in [`docs/superpowers/specs/`](docs/superpowers/specs/), one document
per decision, each stating what was rejected and why.
