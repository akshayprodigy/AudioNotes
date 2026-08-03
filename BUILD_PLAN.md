# AudioNotes — MVP Technical Build Plan

**Product:** InnoCore Meeting Note-Taker ("AudioNotes")
**Owner:** Akshay Ghosh, InnoCore Labs Pvt. Ltd.
**Scope of this document:** Engineering plan for the Android MVP (Free + Pro tiers), structured so the same app layer extends to iOS and the Deep (server) tier later.
**Companion document:** `InnoCore_MeetingNoteTaker_PRD_v3.docx` (product requirements). This plan implements it; where they disagree, the PRD wins on *what* and this plan wins on *how*.

---

## 1. What we are building (MVP boundary)

A fully offline, on-device meeting recorder that produces structured minutes without any audio or text leaving the phone. Everything in the MVP runs locally; no account, no network dependency.

**In scope (Free + Pro):** foreground audio capture with a persistent recording indicator; VAD-based silence stripping; on-device transcription (whisper.cpp); on-device diarization with manual speaker labelling/merging; structured minutes (rule-based floor, on-device LLM enhancement on capable devices); encrypted local storage; search; export via the share sheet; a consent flow.

**Explicitly deferred:** the Deep tier (server inference, sync, cloud backup), iOS, video-call bots, integrations, team features, web. The architecture below leaves clean seams for the Deep tier and iOS, but no code for them ships in the MVP.

**The one hard promise:** no third-party AI. Every model is Apache-2.0 or MIT and runs on the device. This constraint drives every library choice in §9.

---

## 2. Stack decision

**Chosen:** React Native (New Architecture — TurboModules + JSI, Hermes) for the UI, navigation, application state, and pipeline orchestration, over a **shared C++ inference core** exposed through thin native modules (Kotlin + JNI on Android; Swift/Objective-C++ on iOS later).

**Why RN and not pure native:**

- The product targets **iOS and Android**. RN lets us write the entire UI/UX, navigation, list rendering, editing of minutes, speaker-relabelling UI, search, and settings **once**. Those screens are the bulk of the app's surface area and none of them are performance-critical.
- The usual RN performance objection does **not** apply here, because **audio samples and model inference never cross the JS bridge**. Native code captures PCM to disk, runs VAD/ASR/diarization/LLM entirely in C++/Kotlin, and returns only small payloads (transcript text, speaker segments, structured minutes JSON, progress events) to JS. The bridge carries kilobytes of results and control messages, not megabytes of audio.
- The heavy C++ core the PRD already specced (whisper.cpp, llama.cpp, sherpa-onnx, Silero VAD via ONNX Runtime) is **identical** whether the host app is native or RN. RN simply replaces *two separate native UI codebases* with one.

**The seam that makes this safe:** a single native module boundary (`AudioPipeline`) that the JS layer talks to. Everything above the boundary is portable TypeScript; everything below is per-platform native wrapping a shared C++ core. If RN ever becomes a liability for a specific screen, that screen can be dropped to a native view without touching the pipeline.

**Non-negotiable settings:** New Architecture ON (TurboModules + Fabric), Hermes ON, `newArchEnabled=true`. TurboModules give us typed, synchronous-capable native calls and clean event emission for progress.

---

## 3. Architecture at a glance

```
┌─────────────────────────────────────────────────────────────┐
│ React Native (TypeScript, Hermes)                            │
│   UI: Record · Library · Meeting detail · Speakers · Search  │
│   State: Zustand stores  ·  Navigation: React Navigation     │
│   Orchestration: PipelineController (subscribes to events)   │
└───────────────▲──────────────────────────┬──────────────────┘
                │ results / events (JSI)    │ commands (JSI)
┌───────────────┴──────────────────────────▼──────────────────┐
│ Native module boundary  (TurboModules)                       │
│   AudioPipeline · Storage · ModelManager · FileExport        │
├──────────────────────────────────────────────────────────────┤
│ Android host (Kotlin/JNI)          iOS host (Swift/ObjC++)   │
│   Foreground service, AudioRecord   AVAudioEngine  [later]   │
│   Keystore, notifications           Keychain                 │
├──────────────────────────────────────────────────────────────┤
│ Shared C++ core  (libaudionotes)                             │
│   VAD (Silero/ONNX) · ASR (whisper.cpp) ·                    │
│   Diarization (sherpa-onnx) · LLM (llama.cpp) ·              │
│   Alignment + chunking · SQLCipher access                   │
└──────────────────────────────────────────────────────────────┘
```

**Processing pipeline (all on-device):**

```
capture → VAD → ASR → diarization → alignment → structuring → encrypted store
```

---

## 4. The pipeline, stage by stage

Each stage is a discrete step with a defined input and output artifact persisted to disk, so a crash or kill mid-meeting never loses more than the current chunk, and any stage can be re-run without redoing the ones before it.

### 4.1 Capture
- Android `AudioRecord`, **16 kHz mono PCM 16-bit**. This sample rate is what whisper.cpp and Silero both expect; do not resample later.
- Runs inside a **foreground service** with a persistent, non-dismissable notification (also satisfies the consent-indicator requirement).
- **Write PCM to disk in chunks as it arrives — never hold a whole meeting in RAM.** Target on-disk chunk size ~30 s of audio (see §4.2 for why 30 s).
- Handle audio-focus loss, phone calls, and Bluetooth/wired route changes gracefully: pause + resume, mark a gap, never crash the service.

### 4.2 VAD (voice activity detection)
- **Silero VAD** (~1 MB ONNX) via ONNX Runtime.
- Meetings are 30–40% silence; stripping it cuts ASR time proportionally — **VAD is not optional.**
- Produces speech *segments* (start/end timestamps). Chunk the audio **at VAD boundaries near ~30 s**, never mid-word. These chunk boundaries become the re-anchoring points for ASR timestamps.

### 4.3 ASR (transcription)
- **whisper.cpp**, GGML `q5_0`. **base (~75 MB)** for Free, **small (~180 MB)** for Pro.
- Transcribe per VAD chunk. **Whisper timestamps drift over long audio — re-anchor each chunk's timestamps to its VAD start offset** so the global timeline stays correct.
- Language: auto-detect per meeting (multilingual is a core feature, not a regional add-on). Allow a manual language override in settings.
- Emit incremental progress events to JS (`{stage:'asr', chunk, total}`) for the UI progress bar.

### 4.4 Diarization (who spoke when)
- **sherpa-onnx**: segmentation model → speaker-embedding model → clustering.
- Runs on the same VAD segments; output is a list of `(start, end, speakerCluster)` labels.
- **This is the category's weak spot and our accuracy risk.** The guaranteed fallback is a manual speaker-labelling + merge UI (see §5, Speakers screen). Diarization proposes; the user corrects.
- **License caveat:** sherpa-onnx is Apache-2.0, but that does **not** automatically cover every model weight it can load. Verify each pyannote-derived checkpoint's license individually before shipping it.

### 4.5 Alignment
- Merge the ASR word/segment timeline with the diarization timeline into a single ordered transcript: each utterance carries `text`, `startMs`, `endMs`, `speakerId`.
- This is pure C++/logic, no model. It is the artifact the minutes are built from and the thing the user reads/edits.

### 4.6 Structuring (minutes)
Two-floor strategy so quality degrades gracefully instead of failing:

1. **Rule-based floor (always runs, all tiers):** regex/heuristic extraction of action items ("I'll…", "can you…", "we need to…", "by Friday"), decisions, owners, dates, and questions. Deterministic, fast, no model. This alone must produce *usable* minutes — it's the Free-tier guarantee and the safety net if the LLM is unavailable or weak.
2. **LLM enhancement (Pro, capable devices):** **Qwen3 1.7B / 4B, Q4_K_M, via llama.cpp.** Produces structured minutes: summary, decisions, owners, action items, open questions.
   - **Meetings over ~20 min must use chunked map-reduce** — summarize per chunk, then reduce. Mobile RAM and context windows cannot do a 60-minute meeting in one shot.
   - Device-capability gating decides base-vs-small and whether the LLM step runs at all (RAM, SoC tier). On weak devices, silently fall back to the rule-based floor rather than thrashing.

### 4.7 Encrypted store
- **SQLCipher**; keys held in the **Android Keystore** (iOS Keychain later). Audio files encrypted at rest too (or deleted post-transcription per a user setting).
- Everything above is written here as it completes; the Library screen reads from here.

---

## 5. App layer (RN / TypeScript) module breakdown

| Area | Responsibility | Notes |
|---|---|---|
| `screens/Record` | Start/stop, live level meter, elapsed time, consent gate | Talks only to `AudioPipeline.start/stop` |
| `screens/Library` | List of meetings, status (processing/done), search entry | Reads SQLCipher via `Storage` module |
| `screens/Meeting` | Transcript view, structured minutes, edit, export | Renders aligned transcript + minutes |
| `screens/Speakers` | Relabel and **merge** diarized speakers | The guaranteed diarization fallback |
| `screens/Search` | Full-text search across meetings | FTS5 in SQLCipher |
| `screens/Settings` | Model management, language, tier, audio-retention, consent copy | Talks to `ModelManager` |
| `state/*` (Zustand) | Recording state, processing queue, library cache | No business logic in components |
| `pipeline/PipelineController` | Subscribes to native progress events, updates state, drives retries | The JS-side orchestrator |
| `native/*` (TS specs) | TurboModule TypeScript interfaces (codegen source of truth) | See §6 |
| `db/*` | Typed query layer over `Storage` module | Migrations live here |

Guiding rule: **components render, stores hold state, the pipeline controller coordinates, native does the heavy work.** No screen calls a model directly.

---

## 6. Native module boundary (TurboModule specs)

Four TurboModules. TypeScript spec files are the codegen source of truth; each platform implements them.

- **`AudioPipeline`** — `start(config): Promise<sessionId>`, `stop(sessionId): Promise<void>`, `process(meetingId, options): Promise<void>`, `cancel(meetingId)`. Emits events: `onCaptureLevel`, `onStageProgress`, `onStageComplete`, `onError`. This is the single seam between JS and the C++ core.
- **`Storage`** — open/close the SQLCipher DB, run typed queries, manage the key via Keystore. Exposes CRUD for meetings, utterances, speakers, minutes; FTS search.
- **`ModelManager`** — list/download/verify/delete model files (whisper base/small, Silero, sherpa checkpoints, Qwen GGUF). Staged download with resumability and checksum verification. Emits download progress. **Models download on first run, not bundled** — a 2.5 GB APK kills install conversion.
- **`FileExport`** — render a meeting to Markdown/plain text/`.txt`/`.srt` and hand to the Android share sheet.

**Threading:** all pipeline work runs off the JS thread and off the UI thread — on a dedicated native worker (Android: a bound `Executor`/coroutine dispatcher inside the foreground service). JS only ever receives events.

---

## 7. Data model (SQLCipher)

```
meetings(id, title, created_at, duration_ms, language, status, tier_used, audio_path, audio_retained)
utterances(id, meeting_id, start_ms, end_ms, speaker_id, text)          -- aligned transcript
speakers(id, meeting_id, cluster_label, display_name)                    -- editable, mergeable
minutes(id, meeting_id, kind, content_json, source)                      -- kind: summary|decision|action|question; source: rule|llm
models(id, name, kind, version, path, sha256, size_bytes, installed_at)  -- ModelManager registry
meetings_fts(...)                                                         -- FTS5 over utterances.text + minutes
```

`status` walks: `recording → captured → vad → asr → diarized → aligned → structured → done` (plus `error`). Persisting the stage makes processing **resumable** — re-open a half-processed meeting and continue from its last completed stage.

---

## 8. Libraries & licenses (Apache-2.0 / MIT only)

| Stage | Component | License |
|---|---|---|
| Capture | `AudioRecord` (Android) / `AVAudioEngine` (iOS) — 16 kHz mono PCM | — |
| VAD | Silero VAD (~1 MB, ONNX) | MIT |
| ASR | whisper.cpp, GGML q5_0 — base (~75 MB) / small (~180 MB) | MIT |
| Diarization | sherpa-onnx — segmentation + embedding + clustering | Apache-2.0 (verify each weight) |
| LLM (device) | Qwen3 1.7B / 4B, Q4_K_M, via llama.cpp | Apache-2.0 |
| LLM (server, Deep/V2) | Qwen3 14B / 32B via vLLM or llama.cpp server | Apache-2.0 |
| Storage | SQLCipher; keys in Android Keystore / iOS Keychain | — |
| App shell | React Native (New Arch), React Navigation, Zustand | MIT |

**Excluded by the license constraint:** Llama (community license) and Gemma (Google terms). Qwen and Mistral families are the safe on-device choices. This is a product promise, not a preference — do not let a transitive dependency pull in a non-permissive model weight.

**Runtime reality:** three runtimes (ONNX Runtime, whisper.cpp, llama.cpp) share the C++ core via JNI/Swift bindings. Forcing a single runtime costs more than it saves. On iOS (later), use whisper.cpp's Core ML encoder path on Apple silicon despite breaking runtime uniformity — it is meaningfully faster.

---

## 9. Build order (milestones)

Ordered to get to a dogfoodable alpha fast, then layer quality. Each milestone ends in something runnable.

1. **Capture + VAD + encrypted storage** — foreground service, PCM-to-disk chunking, Silero VAD, SQLCipher schema + Keystore. Deliverable: record a meeting, see it stored, silence stripped. *(no ASR yet)*
2. **whisper.cpp integration → internal alpha** — base model, per-chunk transcription with timestamp re-anchoring, ModelManager download flow. **Dogfood from here** on a real device.
3. **Rule-based minutes** — deterministic action/decision/owner/question extraction. Free tier is now genuinely useful.
4. **Diarization + manual labelling/merge UI** — sherpa-onnx pipeline + the Speakers screen fallback.
5. **On-device LLM summarization** — Qwen3 via llama.cpp, chunked map-reduce, device-capability gating.
6. **Search + export → Free + Pro launch** — FTS5 search, share-sheet export, onboarding/consent polish. **Ship.**
7. **iOS port** — reuse the entire RN layer; implement the four TurboModules in Swift/ObjC++ over the same C++ core; Core ML encoder path.
8. **Deep tier infrastructure** — single GPU VPS (RTX 4000-class, ~$150–250/mo), server Qwen3 14B/32B, encrypted backup + sync. Launch only past ~20 subscribers (break-even).

**Critical-path advice from the PRD, carried forward:** validate battery/thermal on **real budget hardware in week one**, not an emulator. The success criteria in §10 assume a mid-range Snapdragon 6-series device.

---

## 10. Success criteria (definition of done for MVP)

- Full offline cycle on a mid-range Android (Snapdragon 6-series era) with **no network**.
- 30-minute recording processed in **under 5 minutes, under 10% battery, no thermal throttling**.
- Correct speaker labels on a real 4-person, 30-minute meeting (after at most light manual correction).
- **Airplane-mode test passes end to end.**
- Minutes usable **without manual cleanup**.
- Personal validation: replaces Akshay's existing note-taking for one month of real client meetings.

---

## 11. Repository layout

```
AudioNotes/
├── BUILD_PLAN.md                  ← this document
├── InnoCore_MeetingNoteTaker_PRD_v3.docx
├── package.json
├── App.tsx
├── src/
│   ├── screens/                   Record, Library, Meeting, Speakers, Search, Settings
│   ├── navigation/
│   ├── state/                     Zustand stores
│   ├── pipeline/                  PipelineController + types
│   ├── db/                        typed queries + migrations
│   ├── native/                    TurboModule TS specs (codegen source)
│   └── theme/
├── android/
│   └── app/src/main/java/.../nativemodules/   Kotlin TurboModule impls + foreground service
├── cpp/                           shared C++ core (libaudionotes): vad, asr, diar, llm, align
├── ios/                           (added at milestone 7)
└── docs/
```

---

## 12. Open questions / risks to resolve early

- **Diarization accuracy** on real 4-person in-person audio — biggest technical unknown. Manual merge UI is the guaranteed floor; measure real accuracy at milestone 4 before investing in enrollment mode.
- **Small-model summary quality** — the rule-based floor must stand on its own; treat the LLM as enhancement, not dependency.
- **Model download friction (~2.5 GB total across models)** — staged download, base model first, clear onboarding. Never block first record on a full download.
- **Consent-law variance by jurisdiction** — mandatory in-app indicator + one-time consent flow; keep the copy configurable.
- **Per-weight license verification** for every sherpa/pyannote checkpoint before it ships.
- **Free competition** (Fathom free unlimited, Google Recorder, native dictation) — compete on *no-third-party-AI* and *in-person focus*, not price.
