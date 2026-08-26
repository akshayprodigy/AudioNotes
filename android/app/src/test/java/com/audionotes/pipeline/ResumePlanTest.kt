package com.audionotes.pipeline

import org.junit.Assert.assertEquals
import org.junit.Test

class ResumePlanTest {
  private fun plan(
    status: String,
    seg: Boolean,
    utt: Boolean,
    spk: Boolean,
    narr: Boolean = false,
  ) =
    ResumePlan.remaining(
      ResumePlan.State(
        status = status,
        hasSegments = seg,
        hasUtterances = utt,
        hasSpeakers = spk,
        hasNarrative = narr,
      ),
    )

  @Test fun freshCapture_runsAllStages() {
    assertEquals(
      listOf(Stage.VAD, Stage.ASR, Stage.DIARIZE, Stage.NARRATE),
      plan("captured", false, false, false),
    )
  }

  @Test fun vadDone_skipsVad() {
    assertEquals(listOf(Stage.ASR, Stage.DIARIZE, Stage.NARRATE), plan("vad", true, false, false))
  }

  @Test fun asrDone_resumesAtDiarize() {
    assertEquals(listOf(Stage.DIARIZE, Stage.NARRATE), plan("asr", true, true, false))
  }

  @Test fun diarizeDone_stillOwesNarration() {
    // Every native stage has run but the meeting has no prose yet. This used to be the end of the
    // plan; narration is the stage that turns a transcript into something a person will read.
    assertEquals(listOf(Stage.NARRATE), plan("diarized", true, true, true))
  }

  @Test fun narrationDone_nothingNative() {
    assertEquals(emptyList<Stage>(), plan("done", true, true, true, narr = true))
  }

  @Test fun statusAheadOfRows_rerunsFromMissingRows() {
    // status says asr but utterances never committed (killed mid-write) -> ASR must re-run.
    assertEquals(
      listOf(Stage.ASR, Stage.DIARIZE, Stage.NARRATE),
      plan("asr", true, false, false),
    )
  }

  @Test fun noSpeechIsTerminal_notResumable() {
    // VAD ran, produced no segments -> ASR/diarize impossible; caller treats as terminal.
    // Narration must NOT be appended here: there is no transcript to narrate, and adding it would
    // hand the caller a stage it can never complete, so the meeting would be swept forever.
    assertEquals(emptyList<Stage>(), plan("vad", false, false, false))
  }

  @Test fun narrationIsAlwaysLast() {
    // The prose is written from the finished transcript, so it can only be the final stage. Any
    // plan that contains it must end with it.
    for (state in listOf(
      plan("captured", false, false, false),
      plan("vad", true, false, false),
      plan("asr", true, true, false),
      plan("diarized", true, true, true),
    )) {
      assertEquals("NARRATE must be last in $state", Stage.NARRATE, state.last())
    }
  }
}
