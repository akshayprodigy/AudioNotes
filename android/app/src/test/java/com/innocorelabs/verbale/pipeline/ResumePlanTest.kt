package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Test

class ResumePlanTest {
  private fun plan(
    status: String,
    seg: Boolean,
    utt: Boolean,
    spk: Boolean,
    narr: Boolean = false,
    force: Boolean = false,
  ) =
    ResumePlan.remaining(
      ResumePlan.State(
        status = status,
        hasSegments = seg,
        hasUtterances = utt,
        hasSpeakers = spk,
        hasNarrative = narr,
      ),
      force,
    )

  /**
   * "Write it again" on a meeting that already has prose.
   *
   * The screen used to clear the existing rows so this planner would find work to do, which meant
   * a rewrite that could not run — a lapsed subscription, a deleted model, an out-of-memory kill —
   * destroyed the summary it was replacing.
   */
  @Test fun forceReNarratesAMeetingThatIsAlreadyDone() {
    assertEquals(
      listOf(Stage.NARRATE),
      plan("done", seg = true, utt = true, spk = true, narr = true, force = true),
    )
  }

  @Test fun forceAddsNothingElseToThePlan() {
    assertEquals(
      listOf(Stage.NARRATE),
      plan("done", seg = true, utt = true, spk = true, narr = false, force = true),
    )
  }

  /**
   * A forced narration cannot resurrect a meeting with no speech in it: there is no transcript to
   * narrate, so the stage could never complete and the meeting would be swept forever instead of
   * being marked terminal.
   */
  @Test fun forceCannotResurrectANoSpeechRecording() {
    assertEquals(
      emptyList<Stage>(),
      plan("error", seg = false, utt = false, spk = false, narr = false, force = true),
    )
  }

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
