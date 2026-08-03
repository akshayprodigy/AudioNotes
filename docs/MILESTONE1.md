# Milestone 1 — Capture + VAD + Encrypted Storage

**Goal (from BUILD_PLAN §9):** record a meeting, store it encrypted, and strip silence with VAD.
This milestone has **no ASR yet** — after processing you see speech *segments*, not a transcript.

## What was implemented

**Capture** (`android/.../pipeline/RecordingService.kt`, `AudioPipelineModule.kt`)
- Foreground service with the persistent recording indicator (also the consent signal).
- `AudioRecord` at 16 kHz mono PCM16 (UNPROCESSED source), streamed to
  `filesDir/meetings/<id>/audio.pcm` in 4 KB chunks — a whole meeting is never held in RAM.
- On stop, the meeting is marked `captured` with a real duration derived from the byte count.

**Encrypted storage** (`android/.../data/AudioDb.kt`, `KeystoreKeyManager.kt`, `StorageModule.kt`)
- SQLCipher DB (`audionotes.db`) opened with a random 256-bit passphrase that is wrapped by a
  non-exportable Android Keystore AES-GCM key. The raw passphrase is never stored in the clear.
- Canonical schema lives in `AudioDb` (mirrored in `src/db/schema.ts`); `StorageModule` is the
  thin TurboModule the JS `db` layer calls.

**VAD** (`cpp/vad/silero_vad.{h,cpp}`, `cpp/jni/audionotes_jni.cpp`, `NativeBridge.kt`)
- Streaming Silero VAD via ONNX Runtime — reads the PCM file frame by frame (512 samples),
  carries the recurrent state, and emits merged, padded speech segments in ms.
- `process()` runs VAD off-thread, stores segments, advances status to `vad`, and emits
  `onStageProgress`. The Meeting screen shows the segment count + total speech.

## What you must provide before it runs

1. **NDK + CMake** (the project already pins NDK `27.1.12297006`; install via SDK Manager).
2. **The Silero VAD model.** Drop `silero_vad.onnx` (v4 signature — inputs `input/sr/h/c`,
   outputs `output/hn/cn`, MIT) into `android/app/src/main/assets/`. On first `process()` it is
   copied to `filesDir/models/`. (Milestone 2's ModelManager will download it instead of bundling.)
   - If your model is Silero **v5** (single `state` input), adjust `Impl::infer` in
     `silero_vad.cpp` accordingly — the I/O names/shapes are localized there.

## Build & run (on your machine — cannot be built in the cloud session)

```bash
npm install
npx react-native run-android      # or: npm run android
```

First build compiles the C++ core (CMake pulls ONNX Runtime headers/libs from the
`onnxruntime-android` AAR via prefab) and links `libaudionotes.so`.

## Smoke test (the milestone-1 success slice)

1. Launch, tap **Record**, accept the mic + notification permissions, consent, record ~20s with
   some talking and some silence, tap **Stop**.
2. You land on the meeting; within a moment the green **VAD** line shows the speech segments and
   total speech seconds — silence excluded.
3. Turn on **airplane mode** and repeat: it must work identically (fully offline).

## Known follow-ups (next milestones)

- ASR (whisper.cpp) per VAD chunk with timestamp re-anchoring → milestone 2.
- `ModelManager` TurboModule for staged, checksum-verified model download → milestone 2.
- Chunk the audio at VAD boundaries (~30 s) as the ASR feed — the segment list is ready for it.
