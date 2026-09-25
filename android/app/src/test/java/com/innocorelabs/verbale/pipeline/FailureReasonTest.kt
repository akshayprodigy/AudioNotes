package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FailureReasonTest {
  @Test fun outOfMemoryIsSaidAsMemory() =
    assertTrue(FailureReason.of(OutOfMemoryError()).contains("ran out of memory"))

  @Test fun aMissingLibraryIsTheSpeechEngine() =
    assertTrue(FailureReason.of(UnsatisfiedLinkError("dlopen failed")).contains("speech engine"))

  @Test fun theProcessorCheckKeepsItsOwnSentence() =
    assertEquals(DeviceFit.CPU_REASON, FailureReason.of(IllegalStateException(DeviceFit.CPU_REASON)))

  @Test fun missingAudioSaysSo() =
    assertTrue(FailureReason.of(IllegalStateException("no audio for m1")).contains("audio file is missing"))

  @Test fun aMissingSpeechDetectorSaysSo() =
    assertTrue(
      FailureReason.of(IllegalStateException("silero_vad.onnx not found — place it in assets/"))
        .contains("speech detector"),
    )

  /** Exception text is for the log. A person never reads "SQLiteException: no such column". */
  @Test fun anythingElseIsThePlainFallbackNeverTheRawMessage() =
    assertEquals(FailureReason.FALLBACK, FailureReason.of(RuntimeException("SQLiteException: no such column x")))
}
