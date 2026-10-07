package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The retention window, case for case with `resolveRetentionDays` in __tests__/retention.test.ts.
 *
 * The two implementations have to agree exactly, because they answer different halves of the same
 * question: JS decides what the Settings screen SAYS is happening to the audio, and this decides
 * what actually happens to it. A disagreement deletes a recording the user has just been told is
 * still there.
 */
class AudioRetentionTest {
  private fun days(stored: String?, legacy: String?) = AudioRetention.resolveDays(stored, legacy)

  @Test fun defaultsToAWeekWhenNothingHasEverBeenSet() {
    assertEquals(AudioRetention.DEFAULT_DAYS, days(null, null))
    assertEquals(7, AudioRetention.DEFAULT_DAYS)
  }

  /** -1 is the sentinel for forever. Somebody who turned the old switch on wanted the audio kept. */
  @Test fun honoursTheLegacySwitchAsKeepUntilIDeleteIt() {
    assertEquals(-1, days(null, "1"))
  }

  /**
   * The old meaning of '0' was "discard as soon as a transcript exists". Carrying that forward
   * would keep playback broken for every existing install, which is the bug this replaces.
   */
  @Test fun treatsTheLegacySwitchOffAsTheNewDefault() {
    assertEquals(AudioRetention.DEFAULT_DAYS, days(null, "0"))
  }

  @Test fun anExplicitWindowWinsOverTheLegacySwitchInBothDirections() {
    assertEquals(30, days("30", "1"))
    assertEquals(-1, days("-1", "0"))
    assertEquals(0, days("0", "1")) // delete as soon as there is a transcript
  }

  /**
   * Reading a malformed value as a window would mean "delete everything now" — the one outcome a
   * parsing accident must never be able to produce.
   */
  @Test fun fallsBackRatherThanDeletingWhenTheStoredWindowIsMalformed() {
    assertEquals(AudioRetention.DEFAULT_DAYS, days("", null))
    assertEquals(AudioRetention.DEFAULT_DAYS, days("7 days", null))
    assertEquals(AudioRetention.DEFAULT_DAYS, days("3.5", null))
    assertEquals(-1, days("  ", "1"))
  }

  /** The sample meeting's audio is bundled with the app and is never reclaimed; a real meeting's is. */
  @Test fun theBundledSampleIsNeverSweptButARealMeetingIs() {
    assertEquals(true, AudioRetention.neverSwept("sample-meeting-v1"))
    assertEquals(false, AudioRetention.neverSwept("3f2a9c1e-0b7d-4c55-9a52-61d0f4c0a1de"))
    assertEquals(false, AudioRetention.neverSwept("my-sample-recording"))
  }
}
