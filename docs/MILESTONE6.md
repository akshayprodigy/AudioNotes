# Milestone 6 — Search + Export → Free + Pro launch

**Goal (BUILD_PLAN §9):** the last user-facing pieces, and the pre-launch checklist. With this,
the Free + Pro MVP is feature-complete: record → transcript → speakers → minutes → **search + export**.

## What was implemented

**Export** (`android/.../pipeline/FileExportModule.kt`, FileProvider)
- Renders a meeting to **Markdown**, **plain text**, or **SRT** (subtitles from utterance
  timestamps), writes it to `cacheDir/exports`, and shares it through the Android share sheet via a
  `FileProvider` content URI (declared in the manifest with `res/xml/file_paths.xml`).
- Markdown/text include the title, date, summary, decisions, action items, open questions, and the
  speaker-attributed transcript. The Meeting screen's **Export** button now offers the three formats.

**Search** (already wired in M2, standalone FTS5)
- The Search screen queries `meetings_fts` (populated from every transcript) and opens the matching
  meeting. Fully offline.

**Onboarding polish**
- Library empty state now points first-time users to Settings to download the transcription model
  and reassures them everything runs on-device.

## Pre-launch checklist (do these before shipping Free + Pro)

1. **Vendor the three C++ engines** as submodules and get a clean release build:
   - `cpp/third_party/whisper.cpp`, `cpp/third_party/sherpa-onnx`, `cpp/third_party/llama.cpp`.
   - Resolve the sherpa-onnx ↔ ONNX Runtime sharing (M4 note) and the llama.cpp API version (M5 note).
2. **Fill in `sha256` for every model in `ModelCatalog.kt`.** They are blank today, so download
   verification is skipped with a warning. This is a correctness + supply-chain gate.
3. **Verify model licenses individually** — especially the pyannote-derived diarization checkpoint.
   Confirm every shipped weight is Apache-2.0 / MIT (the product's core promise).
4. **Real-device validation** (BUILD_PLAN §7 success criteria), not an emulator:
   - Full offline cycle on a mid-range Snapdragon 6-series device.
   - 30-min recording processed in < 5 min, < 10% battery, no thermal throttling.
   - Correct speaker labels on a real 4-person, 30-min meeting (after light correction).
   - Airplane-mode test end to end. Minutes usable without cleanup.
5. **Model download onboarding** — first-run flow that downloads base whisper (and optionally the
   Qwen + diarization models) with clear progress; never block the first recording on a full download.
6. **Consent copy per jurisdiction** — keep the in-app indicator mandatory; make the one-time consent
   text configurable.
7. **Release signing** — replace the debug keystore in `android/app/build.gradle` with a real
   upload key before publishing.
8. **Personal validation** — replace your own note-taking for one month of real client meetings.

## Status

Milestones 1–6 implemented and statically verified (unit tests for the minutes + summarizer;
all C++ enabled/disabled paths compile-checked against stub headers; TS/Kotlin/XML checks clean).
The remaining work to ship is the on-device integration + validation in the checklist above — it
needs your Android toolchain and real hardware, which the cloud session can't run.

## After launch

- **M7 — iOS port:** reuse the entire RN layer; implement the five TurboModules (AudioPipeline,
  Storage, ModelManager, Llm, FileExport) in Swift/Objective-C++ over the same `cpp/` core; use
  whisper.cpp's Core ML encoder on Apple silicon.
- **M8 — Deep tier:** single GPU VPS, server Qwen 14B/32B, encrypted backup + multi-device sync.
  Launch past ~20 subscribers (infra break-even).
