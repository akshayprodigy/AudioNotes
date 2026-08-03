# Milestone 2 — whisper.cpp ASR + ModelManager

**Goal (BUILD_PLAN §9):** on-device transcription per VAD chunk, and a real model-download flow —
enough to dogfood an internal alpha. Full offline cycle: record → VAD → **transcript**.

## What was implemented

**ModelManager** (`android/.../pipeline/ModelManagerModule.kt`, `data/ModelCatalog.kt`)
- Catalog of `silero-vad`, `whisper-base`, `whisper-small` (filename, URL, size, optional sha256).
- Resumable HTTP download (`Range` header + `.part` file), progress events (`onModelProgress`),
  optional sha256 verification, `remove`, and `list` with installed flags. Downloaded models are
  recorded in the `models` table. Nothing is bundled in the APK.
- Settings screen now shows size, live download %, and download/remove per model.

**Whisper ASR** (`cpp/asr/whisper_asr.{h,cpp}`, `jni`, `NativeBridge.nativeTranscribe`)
- Combines VAD spans into ~30 s chunks, runs `whisper_full` per chunk, and **re-anchors** each
  segment's timestamps (whisper reports centiseconds relative to the chunk) back onto the global
  meeting timeline. Language is `auto` (multilingual).
- Reads only the needed PCM window per chunk from disk — never loads the whole meeting.
- Guarded by `HAVE_WHISPER`: the project compiles before whisper.cpp is vendored;
  `transcribe()` throws a clear "not compiled in" error until then.

**Pipeline wiring** (`AudioPipelineModule.process`)
- After VAD, if the selected whisper model is installed, it transcribes, stores utterances,
  populates FTS, advances status to `asr`, and emits `asr` progress. If no model is installed,
  it logs and stops at `vad` (no failure). The Meeting screen renders the transcript.

**Storage** (`AudioDb`)
- FTS is now a standalone `fts5(meeting_id UNINDEXED, text)` — simple to repopulate per meeting.
- `replaceUtterancesJson` writes the transcript + FTS rows in one transaction.

## What you must provide before it runs

1. **Vendor whisper.cpp** (built automatically when present):
   ```bash
   git submodule add https://github.com/ggerganov/whisper.cpp cpp/third_party/whisper.cpp
   ```
2. **Silero VAD model** — as in milestone 1, in `assets/` or via ModelManager. The VAD code now
   **auto-detects v4 (h/c) vs v5 (state)** model signatures, so either works.
3. **Whisper model** — open Settings in the app and Download "Whisper base (q5_1)" (or push it to
   `filesDir/models/` yourself). Fill in the `sha256` fields in `ModelCatalog.kt` before shipping;
   until then verification is skipped with a warning.

## Build & run (on your machine)

```bash
npm install
npx react-native run-android
```

First build compiles the C++ core including whisper.cpp (this is the slow one — it builds the
whisper + ggml static libs for each ABI).

## Smoke test

1. Settings → Download the base whisper model (needs network once).
2. Record ~30 s with speech, Stop. Processing runs VAD then ASR.
3. Open the meeting: the VAD line shows speech segments, and the **Transcript** section fills in.
4. Airplane mode after the model is downloaded: record + transcribe must still work fully offline.
5. Search: type a word you said — it should surface the meeting (FTS).

## Follow-ups (next milestones)

- Milestone 3: rule-based minutes (action/decision/owner/question extraction) — Free tier value.
- Milestone 4: diarization (sherpa-onnx) + the manual speaker labelling/merge UI.
- Consider per-chunk ASR progress events (native → JS) for a finer progress bar.
