package com.innocorelabs.verbale.pipeline

/**
 * What a crashed processing run tells the person, in words they can act on. The exception itself
 * goes to the log; its message is never shown, because it is written for a developer.
 */
object FailureReason {
  const val FALLBACK = "Processing stopped unexpectedly. The recording is safe — tap Try again."

  fun of(e: Throwable): String {
    val message = e.message ?: ""
    return when {
      e is OutOfMemoryError ->
        "The phone ran out of memory while processing. Close other apps, then tap Try again."
      e is UnsatisfiedLinkError ->
        "The speech engine could not start on this phone. Reinstalling Verbale usually fixes this."
      message == DeviceFit.CPU_REASON -> DeviceFit.CPU_REASON
      message.startsWith("no audio for") ->
        "The recording's audio file is missing, so there is nothing to process."
      message.startsWith("silero_vad.onnx not found") ->
        "The speech detector is not on the phone yet. Connect to the internet, open Verbale, then tap Try again."
      else -> FALLBACK
    }
  }
}
