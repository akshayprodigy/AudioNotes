package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServiceTimeoutTest {
  @Test fun nothingInFlightIsNotWorthANotification() {
    assertNull(ServiceTimeout.notice(null, 0))
  }

  @Test fun aRunningMeetingIsAlwaysWorthOne() {
    val n = ServiceTimeout.notice("m1", 0)
    assertTrue(n != null)
    assertEquals("Paused for today", n!!.title)
    assertTrue(n.text.contains("six hours"))
    assertTrue(n.text.contains("Open Verbale"))
    assertTrue(!n.text.contains("waiting"))
  }

  @Test fun aQueueIsCountedAndPluralised() {
    assertTrue(ServiceTimeout.notice("m1", 1)!!.text.endsWith("1 more meeting is waiting."))
    assertTrue(ServiceTimeout.notice("m1", 3)!!.text.endsWith("3 more meetings are waiting."))
  }

  @Test fun aQueueWithNothingRunningStillSpeaks() {
    assertTrue(ServiceTimeout.notice(null, 2) != null)
  }
}
