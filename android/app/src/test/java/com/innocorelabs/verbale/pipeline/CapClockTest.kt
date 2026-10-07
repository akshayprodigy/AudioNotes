package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.pipeline.CapClock.Phase
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What a FREE recording's limit looks like while it runs. The boundaries match the record
 * screen's own card (src/billing/recordingCap.ts, WARN_BEFORE_MS = 5 minutes) so the PiP window,
 * the notification and the screen change at the same second.
 */
class CapClockTest {
  private val cap = 3_600_000L // 60 minutes

  @Test fun `the warning is five minutes, as on the record screen`() {
    assertEquals(5 * 60_000L, CapClock.WARN_BEFORE_MS)
  }

  @Test fun `a recording with no limit is just the clock`() {
    assertEquals(Phase.UNCAPPED, CapClock.phase(252_000L, 0L))
    assertEquals("04:12", CapClock.pipLabel(252_000L, 0L))
    assertEquals("75:03", CapClock.pipLabel(4_503_000L, 0L))
  }

  @Test fun `a free recording shows its limit from the start`() {
    assertEquals(Phase.QUIET, CapClock.phase(252_000L, cap))
    assertEquals("04:12 / 60:00", CapClock.pipLabel(252_000L, cap))
    assertEquals("54:59 / 60:00", CapClock.pipLabel(3_299_999L, cap))
  }

  @Test fun `the countdown starts exactly five minutes before the limit`() {
    assertEquals(Phase.QUIET, CapClock.phase(3_299_999L, cap))
    assertEquals(Phase.WARNING, CapClock.phase(3_300_000L, cap))
    assertEquals("5:00 left on Free", CapClock.pipLabel(3_300_000L, cap))
    assertEquals("4:48 left on Free", CapClock.pipLabel(3_312_000L, cap))
  }

  @Test fun `the last minute is its own phase`() {
    assertEquals(Phase.WARNING, CapClock.phase(3_539_999L, cap))
    assertEquals("1:01 left on Free", CapClock.pipLabel(3_539_999L, cap))
    assertEquals(Phase.FINAL, CapClock.phase(3_540_000L, cap))
    assertEquals("1:00 left on Free", CapClock.pipLabel(3_540_000L, cap))
  }

  @Test fun `the countdown rounds up so it never reads a second early`() {
    assertEquals("0:41 left on Free", CapClock.pipLabel(3_559_000L, cap))
    assertEquals("0:41 left on Free", CapClock.pipLabel(3_559_500L, cap))
  }

  @Test fun `past the limit it holds at zero`() {
    assertEquals("0:00 left on Free", CapClock.pipLabel(3_600_000L, cap))
    assertEquals("0:00 left on Free", CapClock.pipLabel(3_630_000L, cap))
    assertEquals(0L, CapClock.remainingMs(3_630_000L, cap))
    assertEquals(288_000L, CapClock.remainingMs(3_312_000L, cap))
  }
}
