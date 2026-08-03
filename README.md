# AudioNotes

On-device meeting note-taker. Records in-person meetings and produces structured
minutes **entirely on the device** — no audio or text leaves the phone, no account,
works fully offline (airplane mode). The one hard promise: **no third-party AI**.

Built by InnoCore Labs. See `BUILD_PLAN.md` for the full engineering plan and
`InnoCore_MeetingNoteTaker_PRD_v3.docx` for the product requirements.

## Stack

- **React Native (New Architecture — TurboModules + JSI, Hermes)** for the UI and
  pipeline orchestration — one codebase for Android now and iOS later.
- A shared **C++ core** (`cpp/`) wrapping whisper.cpp, llama.cpp, sherpa-onnx and
  Silero VAD, exposed through thin native modules (Kotlin/JNI on Android).
- **Audio and inference never cross the JS bridge** — native captures PCM to disk
  and runs all models; only small results/events return to JS.

## Pipeline

```
capture → VAD → ASR → diarization → alignment → structuring → encrypted store
```

## Layout

```
src/            TypeScript app layer (portable across Android + iOS)
  screens/      Record, Library, Meeting, Speakers, Search, Settings
  navigation/   React Navigation stack
  state/        Zustand stores
  pipeline/     PipelineController + types (JS-side orchestrator)
  native/       TurboModule specs (codegen source of truth)
  db/           typed query layer + SQLCipher schema
android/        Android host; native modules + foreground RecordingService (Kotlin)
cpp/            shared C++ inference core (libaudionotes) — see cpp/README.md
ios/            iOS host (fleshed out at build milestone 7)
```

## Getting started

> The native modules and C++ core are **stubs** right now — the app boots and the UI
> navigates, but recording/transcription are wired to no-op natives until the C++
> engines are vendored in (see `cpp/README.md`) and the module bodies implemented.

```bash
npm install
# Android
npm run android
# Metro
npm start
```

New Architecture is on by default (`newArchEnabled=true`, Hermes on).

## Build order

See `BUILD_PLAN.md` §9. Short version:
1. Capture + VAD + encrypted storage
2. whisper.cpp → internal alpha (dogfood)
3. Rule-based minutes
4. Diarization + manual labelling/merge UI
5. On-device LLM summarization (Qwen3 via llama.cpp)
6. Search + export → Free + Pro launch
7. iOS port
8. Deep tier (server) infrastructure

## License promise

Apache-2.0 / MIT components only. Excludes Llama and Gemma. Verify each model
weight license individually.
