package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.pipeline.CapClock.Phase
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What a FREE recording's limit looks like while it runs. The boundaries match the record
 * screen's own card (src/billing/recordingCap.ts, WARN_BEFORE_MS = 3 minutes) so the PiP window,
 * the notification and the screen change at the same second.
 */
class CapClockTest {
  private val cap = 900_000L // 15 minutes

  @Test fun `a recording with no limit is just the clock`() {
    assertEquals(Phase.UNCAPPED, CapClock.phase(252_000L, 0L))
    assertEquals("04:12", CapClock.pipLabel(252_000L, 0L))
    assertEquals("75:03", CapClock.pipLabel(4_503_000L, 0L))
  }

  @Test fun `a free recording shows its limit from the start`() {
    assertEquals(Phase.QUIET, CapClock.phase(252_000L, cap))
    assertEquals("04:12 / 15:00", CapClock.pipLabel(252_000L, cap))
    assertEquals("11:59 / 15:00", CapClock.pipLabel(719_999L, cap))
  }

  @Test fun `the countdown starts exactly three minutes before the limit`() {
    assertEquals(Phase.QUIET, CapClock.phase(719_999L, cap))
    assertEquals(Phase.WARNING, CapClock.phase(720_000L, cap))
    assertEquals("3:00 left on Free", CapClock.pipLabel(720_000L, cap))
    assertEquals("2:48 left on Free", CapClock.pipLabel(732_000L, cap))
  }

  @Test fun `the last minute is its own phase`() {
    assertEquals(Phase.WARNING, CapClock.phase(839_999L, cap))
    assertEquals("1:01 left on Free", CapClock.pipLabel(839_999L, cap))
    assertEquals(Phase.FINAL, CapClock.phase(840_000L, cap))
    assertEquals("1:00 left on Free", CapClock.pipLabel(840_000L, cap))
  }

  @Test fun `the countdown rounds up so it never reads a second early`() {
    assertEquals("0:41 left on Free", CapClock.pipLabel(859_000L, cap))
    assertEquals("0:41 left on Free", CapClock.pipLabel(859_500L, cap))
  }

  @Test fun `past the limit it holds at zero`() {
    assertEquals("0:00 left on Free", CapClock.pipLabel(900_000L, cap))
    assertEquals("0:00 left on Free", CapClock.pipLabel(930_000L, cap))
    assertEquals(0L, CapClock.remainingMs(930_000L, cap))
    assertEquals(168_000L, CapClock.remainingMs(732_000L, cap))
  }
}
