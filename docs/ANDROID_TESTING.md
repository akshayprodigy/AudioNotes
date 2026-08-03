# Android testing guide

You build and run on your Mac (real device or emulator). This app has a native C++ core, so plan to
test in **stages** — get the app running with VAD first (no heavy submodules), then add each engine.

## Prerequisites (install once)

- **Node 22+**, **JDK 17**
- **Android Studio** with: SDK Platform **API 36**, Build-Tools **36.0.0**, **NDK 27.1.12297006**,
  **CMake 3.22.1** (SDK Manager → SDK Tools → check "Show Package Details" to pick exact versions).
  These are pinned in `android/build.gradle`; if you have different versions installed, either add
  the pinned ones or edit that file to match what you have.
- A device with **USB debugging on**, or an emulator (arm64 image recommended).
- `ANDROID_HOME` / `ANDROID_SDK_ROOT` set; `adb devices` shows your device.

**Speed tip:** the first native build is slow. While testing, build for just your device's ABI —
edit `android/app/build.gradle` `abiFilters` to only `"arm64-v8a"` (most modern phones). That cuts
whisper/sherpa/llama build time by ~3×.

---

## Stage 1 — Smoke test: UI + VAD + encrypted storage (no submodules)

This proves the toolchain, the RN New-Architecture module wiring, capture, storage, and VAD. Only
ONNX Runtime is needed (pulled automatically by Gradle) — no git submodules yet.

```bash
cd /Users/akshayghosh/ReactNative/InnoCoreLabs/AudioNotes
npm install
# connect a device or boot an emulator, then:
npx react-native run-android
```

In the app:
1. It opens on **Library** (empty). Navigate to Settings, Record, back — confirm the UI works.
2. **Settings → download "Silero VAD"** (2.3 MB, needs network this once).
3. **Record**: accept mic + notification permissions, tap the consent card, record ~20 s with talking
   and silence, **Stop**.
4. You land on the meeting; within a moment the green **VAD** line shows the speech-segment count and
   seconds of speech (silence excluded).
5. **Airplane mode** and repeat — VAD must work fully offline.

> At this stage ASR/diarization/LLM are compiled as stubs. Don't download the whisper/diarization/Qwen
> models yet — their engines aren't built, so processing would error. Add them stage by stage below.

---

## Stage 2 — Transcription (whisper.cpp)

```bash
git submodule add https://github.com/ggerganov/whisper.cpp cpp/third_party/whisper.cpp
npx react-native run-android      # rebuilds the C++ core with whisper
```
Then **Settings → download "Whisper base (q5_1)"** (~57 MB). Record with speech → the meeting's
**Transcript** section fills in, and **rule-based minutes** appear (actions/decisions/questions).
Try **Search** for a word you said.

> llama.cpp API note: `cpp/llm/llama_engine.cpp` targets a recent llama.cpp; that only matters at
> Stage 4. Version details in `docs/MILESTONE5.md`.

---

## Stage 3 — Speakers (sherpa-onnx diarization)

```bash
git submodule add https://github.com/k2-fsa/sherpa-onnx cpp/third_party/sherpa-onnx
npx react-native run-android
```
**Integration knob:** sherpa-onnx must build against the **same** ONNX Runtime already linked via the
`onnxruntime-android` prefab, not fetch its own. See the comments in `cpp/CMakeLists.txt` and
`docs/MILESTONE4.md`. Then **Settings → download the two diarization models**. Record a 2–4 person
conversation → transcript shows speaker names; open **Speakers** to rename/merge and **Regenerate
minutes**.

---

## Stage 4 — LLM-enhanced minutes (llama.cpp / Qwen)

```bash
git submodule add https://github.com/ggerganov/llama.cpp cpp/third_party/llama.cpp
npx react-native run-android
```
On a **≥3 GB RAM** device, **Settings → download "Qwen2.5 1.5B Instruct"** (~1.1 GB). Record → minutes
first show the rule-based version, then upgrade to the LLM version (real summary sentence, cleaner
actions). On a weak device or with no model, you simply keep the rule-based minutes — by design.

---

## Common first-build issues

- **"Module AudioPipeline/Storage/… not found" or a codegen error.** These are hand-written native
  modules under the New Architecture. If the interop layer doesn't resolve them, tell me and I'll
  switch the `src/native/Native*.ts` specs to a `NativeModules`-based accessor (a small change).
- **NDK/CMake "version not found".** Install the exact pinned NDK/CMake in the SDK Manager, or change
  the versions in `android/build.gradle` / `android/app/build.gradle` to what you have.
- **onnxruntime / CMake.** Resolved: the C++ core no longer uses `find_package(onnxruntime)`. It
  vendors the ORT API headers under `cpp/third_party/onnxruntime/include` and loads
  `libonnxruntime.so` at runtime via `dlopen` (`ORT_API_MANUAL_INIT` in `silero_vad.cpp`). The `.so`
  is still supplied by the `com.microsoft.onnxruntime:onnxruntime-android` AAR (packaged into the
  APK), so keep that dependency; no prefab config is needed.
- **Metro not connected / red screen.** Run `npm start` in a separate terminal, then `r` to reload.
- **Out-of-memory during native build.** Add `org.gradle.jvmargs=-Xmx4g` to `android/gradle.properties`.

Paste any build error here and I'll pinpoint the fix.
