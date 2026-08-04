// Shared onnxruntime C++-API bootstrap.
#pragma once

namespace audionotes {

/**
 * Point the onnxruntime C++ wrapper at the runtime's OrtApi. Idempotent and thread-safe.
 *
 * MUST be called before constructing ANY Ort:: object anywhere in this library — including
 * indirectly, via sherpa-onnx, which is statically linked and uses the same wrapper.
 *
 * Why this is not optional, and why it is shared rather than per-engine: the wrapper keeps the
 * OrtApi pointer in `Ort::Global<void>::api_`, a template static with exactly ONE definition
 * across the whole .so. Defining ORT_API_MANUAL_INIT in a single translation unit therefore
 * makes that pointer start as nullptr for EVERY translation unit, not just that one. We do
 * define it (so libonnxruntime.so need not be linked at build time), which means an engine that
 * never calls this reads a null OrtApi and segfaults on its first use.
 *
 * That failure is invisible in the common case: the pipeline happens to run VAD before
 * diarization, VAD initialised the API, and diarization worked. Calling diarization first in a
 * fresh process crashed in SherpaOnnxCreateOfflineSpeakerDiarization with SIGSEGV at address
 * 0x18 — a null OrtApi vtable read, which looks exactly like a corrupt model file and sent me
 * looking at model files for some time. Each engine now initialises explicitly instead of
 * depending on another engine having run first.
 */
void ensureOrtApi();

}  // namespace audionotes
