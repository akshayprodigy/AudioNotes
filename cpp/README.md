# cpp/ — shared C++ inference core (`libaudionotes`)

This is the platform-agnostic heart of AudioNotes. Both Android (JNI) and iOS
(Swift/Objective-C++) call into this same code, so the pipeline behaves identically
across platforms. `audionotes_core.h` sketches the interface.

## Runtimes (vendored as git submodules — not committed to this repo)

| Purpose | Engine | License | Submodule path |
|---|---|---|---|
| VAD | Silero VAD via ONNX Runtime | MIT | `third_party/onnxruntime` + model |
| ASR | whisper.cpp (GGML q5_0) | MIT | `third_party/whisper.cpp` |
| Diarization | sherpa-onnx | Apache-2.0 | `third_party/sherpa-onnx` |
| LLM (device) | llama.cpp + Qwen3 GGUF | Apache-2.0 (weights) | `third_party/llama.cpp` |

Add them with, e.g.:

```
git submodule add https://github.com/ggerganov/whisper.cpp cpp/third_party/whisper.cpp
git submodule add https://github.com/ggerganov/llama.cpp   cpp/third_party/llama.cpp
git submodule add https://github.com/k2-fsa/sherpa-onnx     cpp/third_party/sherpa-onnx
```

## Build wiring (to add)

- Android: a `CMakeLists.txt` here, referenced from `android/app/build.gradle`
  via `externalNativeBuild { cmake { path "../../cpp/CMakeLists.txt" } }`, exposing
  a small JNI shim the Kotlin `AudioPipelineModule` calls.
- iOS (milestone 7): the same `CMakeLists.txt`/sources compiled into the app target;
  use whisper.cpp's Core ML encoder path on Apple silicon.

## Licensing guardrail

The product promise is **no third-party AI, Apache-2.0 / MIT only**. This excludes
Llama (community license) and Gemma (Google terms). Verify each sherpa/pyannote
model *weight* license individually — sherpa-onnx being Apache-2.0 does not cover
every checkpoint it can load.
