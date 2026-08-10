package com.audionotes.pipeline

import org.junit.Assert.assertEquals
import org.junit.Test

class ResumePlanTest {
  private fun plan(status: String, seg: Boolean, utt: Boolean, spk: Boolean) =
    ResumePlan.remaining(
      ResumePlan.State(status = status, hasSegments = seg, hasUtterances = utt, hasSpeakers = spk),
    )

  @Test fun freshCapture_runsAllStages() {
    assertEquals(listOf(Stage.VAD, Stage.ASR, Stage.DIARIZE), plan("captured", false, false, false))
  }

  @Test fun vadDone_skipsVad() {
    assertEquals(listOf(Stage.ASR, Stage.DIARIZE), plan("vad", true, false, false))
  }

  @Test fun asrDone_resumesAtDiarize() {
    assertEquals(listOf(Stage.DIARIZE), plan("asr", true, true, false))
  }

  @Test fun diarizeDone_nothingNative() {
    assertEquals(emptyList<Stage>(), plan("diarized", true, true, true))
  }

  @Test fun statusAheadOfRows_rerunsFromMissingRows() {
    // status says asr but utterances never committed (killed mid-write) -> ASR must re-run.
    assertEquals(listOf(Stage.ASR, Stage.DIARIZE), plan("asr", true, false, false))
  }

  @Test fun noSpeechIsTerminal_notResumable() {
    // VAD ran, produced no segments -> ASR/diarize impossible; caller treats as terminal.
    assertEquals(emptyList<Stage>(), plan("vad", false, false, false))
  }
}
