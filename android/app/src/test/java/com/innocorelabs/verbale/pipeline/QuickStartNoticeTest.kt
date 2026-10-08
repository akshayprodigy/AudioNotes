package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Test

class QuickStartNoticeTest {
  @Test fun `names the day the month rolls over, without a leading zero`() {
    assertEquals("Free meetings are used up until 1 December", QuickStartNotice.exhausted("2026-12-01"))
    assertEquals("Free meetings are used up until 1 November", QuickStartNotice.exhausted("2026-11-01"))
  }

  @Test fun `a date it cannot read is shown as it came`() {
    assertEquals("Free meetings are used up until soon", QuickStartNotice.exhausted("soon"))
    assertEquals("Free meetings are used up until 2026-13-01", QuickStartNotice.exhausted("2026-13-01"))
  }
}
