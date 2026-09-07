package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The arithmetic that decides whether a long meeting gets speaker labels or the phone gets killed.
 *
 * Two failures, and they are not equally bad. Skipping a meeting the phone could have handled
 * costs the user speaker labels for no reason — and an hour-long meeting is ORDINARY here, so a
 * guard that trips easily would quietly strip labels off most of the product. Not skipping a
 * meeting the phone cannot handle costs them the entire recording, because minutes and narration
 * both run after this stage and the OOM killer does not ask.
 *
 * So the tests below pin the real cases at both ends rather than the constants in the middle: the
 * constants come from one measurement on one phone and will move.
 */
class DiarBudgetTest {
  private val gb = 1024L * 1024 * 1024
  private val mb = 1024L * 1024
  private val minutes = 60_000L

  @Test
  fun `a ninety minute meeting on a roomy phone still gets speaker labels`() {
    // The case the founder called ordinary, and the one that must not regress: an hour and a half
    // in a room, on a phone with memory to spare. Diarizing it whole is what every accuracy number
    // this product quotes was measured on.
    val speech = 68 * minutes // ~75% of 90 minutes is speech, which is what AMI measures
    assertEquals(DiarBudget.WHOLE_MEETING, DiarBudget.windowMsFor(5 * gb, speech))
    assertEquals(DiarBudget.WHOLE_MEETING, DiarBudget.windowMsFor(12 * gb, speech))
  }

  @Test
  fun `a twenty five minute meeting fits on a cheap phone`() {
    // Measured on hardware: a 22.7-minute recording diarized cleanly at 0.64x realtime. A guard
    // that skipped this on a mid-range phone would be wrong about the most common meeting there is.
    val speech = 18 * minutes
    assertEquals(DiarBudget.WHOLE_MEETING, DiarBudget.windowMsFor(800 * mb, speech))
  }

  @Test
  fun `a phone with nothing left skips rather than dying`() {
    assertEquals(DiarBudget.SKIP, DiarBudget.windowMsFor(0, 20 * minutes))
    assertEquals(DiarBudget.SKIP, DiarBudget.windowMsFor(-1, 20 * minutes))
    assertEquals(DiarBudget.SKIP, DiarBudget.windowMsFor(40 * mb, 60 * minutes))
  }

  @Test
  fun `a meeting with no speech in it is not diarized`() {
    assertEquals(DiarBudget.SKIP, DiarBudget.windowMsFor(8 * gb, 0))
  }

  @Test
  fun `the answer is only ever whole or skip`() {
    // Windowing was built, measured against AMI, and shelved for costing 6 DER points. Nothing
    // here may quietly reintroduce it by returning a window length.
    for (freeMb in 0..8192 step 32) {
      for (speechMin in longArrayOf(5, 20, 45, 90, 180)) {
        val answer = DiarBudget.windowMsFor(freeMb.toLong() * mb, speechMin * minutes)
        assertTrue(
          "free=${freeMb}MB speech=${speechMin}min produced $answer",
          answer == DiarBudget.WHOLE_MEETING || answer == DiarBudget.SKIP,
        )
      }
    }
  }

  @Test
  fun `more memory never turns a yes into a no, and a longer meeting never turns a no into a yes`() {
    val speech = 60 * minutes
    var seenYes = false
    for (freeMb in 0..8192 step 32) {
      val yes = DiarBudget.windowMsFor(freeMb.toLong() * mb, speech) == DiarBudget.WHOLE_MEETING
      if (yes) seenYes = true
      assertTrue("the answer flipped back to skip at ${freeMb}MB", !seenYes || yes)
    }
    var seenNo = false
    for (speechMin in 1..300) {
      val no = DiarBudget.windowMsFor(4 * gb, speechMin * minutes) == DiarBudget.SKIP
      if (no) seenNo = true
      assertTrue("a longer meeting became affordable again at ${speechMin}min", !seenNo || no)
    }
  }

  @Test
  fun `the padded bound counts the padding and never exceeds the recording`() {
    // Two 10-second spans in a 60-second recording: 20 s of speech plus 500 ms either side of each.
    val spans = longArrayOf(5_000, 15_000, 30_000, 40_000)
    assertEquals(22_000, DiarBudget.paddedSpeechUpperBoundMs(spans, 60_000))
    // Padding cannot invent audio: a recording that is almost all speech caps at its own length.
    assertEquals(20_000, DiarBudget.paddedSpeechUpperBoundMs(longArrayOf(0, 19_500), 20_000))
    // No spans, no speech — and an odd-length array must not read past its end.
    assertEquals(0, DiarBudget.paddedSpeechUpperBoundMs(longArrayOf(), 60_000))
    assertEquals(0, DiarBudget.paddedSpeechUpperBoundMs(longArrayOf(1_000), 60_000))
    // A reversed or empty span contributes nothing rather than a negative.
    assertEquals(0, DiarBudget.paddedSpeechUpperBoundMs(longArrayOf(9_000, 9_000), 60_000))
    assertEquals(0, DiarBudget.paddedSpeechUpperBoundMs(longArrayOf(9_000, 1_000), 60_000))
  }

  @Test
  fun `the message says what survived and offers only what the app can actually do`() {
    val message = DiarBudget.SKIPPED_FOR_MEMORY
    assertTrue("must name what was lost", message.contains("Speakers"))
    assertTrue("must say the transcript survived", message.contains("transcript"))
    assertTrue("must point at Redo, which does retry diarization", message.contains("Redo"))
    // The Speakers screen renames and merges speakers that EXIST; with none it renders
    // "No speakers yet" and offers nothing. Telling the user to label them by hand would send
    // them to an empty screen, so the message must never say so.
    assertTrue(
      "must not promise hand-labelling, which the Speakers screen cannot do",
      !message.contains("label speakers yourself") && !message.contains("yourself"),
    )
  }
}
