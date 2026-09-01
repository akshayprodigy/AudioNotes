# Verbale

On-device meeting note-taker. Records in-person meetings and produces structured
minutes **entirely on the device** — no audio or text leaves the phone, no account,
works fully offline (airplane mode). The one hard promise: **no third-party AI**.

Built by InnoCore Labs. See `BUILD_PLAN.md` for the full engineering plan,
`docs/RELEASE_2026-08.md` for what shipped most recently, and
`InnoCore_MeetingNoteTaker_PRD_v3.docx` for the product requirements.

## Stack

- **React Native (New Architecture — TurboModules + JSI, Hermes)** for the UI and
  pipeline orchestration — one codebase for Android now and iOS later.
- A shared **C++ core** (`cpp/`) wrapping whisper.cpp, Qwen3-ASR, llama.cpp, sherpa-onnx and
  Silero VAD, exposed through thin native modules (Kotlin/JNI on Android).
- **Audio and inference never cross the JS bridge** — native captures PCM to disk
  and runs all models; only small results/events return to JS.

## Pipeline

```
capture → VAD → ASR → diarization → alignment → structuring → narration → encrypted store
```

Every stage runs in a foreground service and is **resumable by stage**, so a process kill
mid-meeting costs one stage rather than the meeting. A recording stopped from the PiP window
or the notification — with no app in the foreground and no JS context alive — is processed to
finished minutes by native alone, and says so with a "Notes ready" notification.

## Layout

```
src/            TypeScript app layer (portable across Android + iOS)
  screens/      Record, Library, Meeting, Speakers, Search, Actions, Settings, Paywall
  navigation/   React Navigation stack
  state/        Zustand stores
  pipeline/     PipelineController + the rule-based minutes (JS side of the shared core)
  native/       TurboModule specs (codegen source of truth)
  db/           typed query layer + SQLCipher schema
android/        Android host: Kotlin TurboModules, the recording/processing foreground
                services, the PiP recorder window and the Quick Settings tile
cpp/            shared C++ inference core (libaudionotes) — see cpp/README.md
ios/            iOS host (fleshed out at build milestone 7)
```

> **Native artefact names keep the old project name on purpose.** `libaudionotes.so`,
> the `an_process` CLI, `audionotes.db` and the `.anbak` backup extension are contracts
> with binaries and files already on people's phones. The app is Verbale; its `.so` is not.

## Getting started

```bash
npm install
# Android
npm run android
# Metro
npm start
```

New Architecture is on by default (`newArchEnabled=true`, Hermes on).

The Android modules and the C++ core are **implemented, not stubs** — capture, VAD, ASR,
sherpa-onnx diarization, alignment, rule-based minutes, llama.cpp narration, SQLCipher storage,
FTS5 search, export, playback and backup all run on device.

ASR is a **layer, not one engine**: `cpp/asr/` holds an `AsrEngine` interface with whisper.cpp and
Qwen3-ASR behind it, and `makeAsrEngine` picks between them from a language policy table — whisper
for English and the ~99 other languages it covers, Qwen3-ASR for Hindi, where whisper reaches 4.1%
Devanagari against Qwen's 69.8% on a real code-switched meeting. Recognition is always faithful to
what was spoken; the language the *minutes* are written in is chosen separately, at narration.
Qwen's weights are not yet in `ModelCatalog`, so it runs only where they are side-loaded. What a fresh clone still
needs is the three engine submodules under `cpp/third_party/` and the models, which download on
first run rather than shipping in the APK. `docs/ANDROID_TESTING.md` brings the stages up one at
a time; `cpp/README.md` covers the submodules.

## Build order

See `BUILD_PLAN.md` §9. Short version:
1. Capture + VAD + encrypted storage ✅
2. whisper.cpp → internal alpha (dogfood) ✅ *(now a two-engine ASR layer — see above)*
3. Rule-based minutes ✅
4. Diarization + manual labelling/merge UI ✅
5. On-device LLM summarization (Qwen2.5 1.5B via llama.cpp) ✅
6. Search + export → Free + Pro launch ✅ *(shipping checklist in `docs/play-console.md`)*
7. iOS port
8. Deep tier (server) infrastructure

## License promise

Apache-2.0 / MIT components only. Excludes Llama and Gemma. Verify each model
weight license individually.
