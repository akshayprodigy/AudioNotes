package com.audionotes.pipeline

/**
 * JNI bridge into the shared C++ core (libaudionotes). Milestone 1 exposes VAD only;
 * ASR / diarization / LLM entry points land in later milestones.
 */
object NativeBridge {
  init {
    System.loadLibrary("audionotes")
  }

  /**
   * Run Silero VAD over a PCM16 mono file. Returns a flat array of speech segments in ms:
   * [start0, end0, start1, end1, ...]. Empty if the whole file is silence.
   */
  external fun nativeVad(pcmPath: String, modelPath: String, sampleRate: Int): LongArray

  /**
   * Transcribe the given VAD speech spans of a PCM16 mono file with whisper.cpp.
   * segStarts/segEnds are parallel arrays (ms). Returns a JSON array string of
   * {start_ms, end_ms, text} utterances with timestamps re-anchored to the meeting timeline.
   */
  /** @param threads 0 = automatic (big.LITTLE-aware default); >0 pins the count, for benchmarks. */
  external fun nativeTranscribe(
    pcmPath: String,
    modelPath: String,
    sampleRate: Int,
    segStarts: LongArray,
    segEnds: LongArray,
    threads: Int = 0,
  ): String

  /**
   * Speaker diarization via sherpa-onnx. Returns flat triples [start_ms, end_ms, speaker, ...].
   * numSpeakers: 0 = auto (threshold clustering); >0 = fixed count.
   */
  external fun nativeDiarize(
    pcmPath: String,
    segModelPath: String,
    embModelPath: String,
    sampleRate: Int,
    numSpeakers: Int,
  ): LongArray

  // ---- LLM (llama.cpp). Handle-based: load once, generate many, then free. ----
  external fun nativeLlmLoad(modelPath: String, nCtx: Int, nThreads: Int): Long
  external fun nativeLlmGenerate(handle: Long, prompt: String, maxTokens: Int): String
  external fun nativeLlmFree(handle: Long)
}
