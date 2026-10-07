package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** D25: the decision `ProcessingEngine`'s catch block makes. The SQL (`markFailed`) is device-only. */
class FailureOutcomeTest {
  @Test fun anOutOfMemoryIsFailedWithTheMemorySentenceAndOneStrike() {
    val o = FailureOutcome.of(OutOfMemoryError("Failed to allocate"), 0)
    assertEquals("failed", o.status)
    assertEquals(FailureReason.of(OutOfMemoryError()), o.reason)
    assertTrue(o.reason.contains("ran out of memory"))
    assertEquals(1, o.newFailCount)
    assertTrue(o.retriable)
  }

  @Test fun aMissingNativeLibraryGetsItsOwnSentence() {
    val o = FailureOutcome.of(UnsatisfiedLinkError("dlopen failed"), 1)
    assertTrue(o.reason.contains("speech engine could not start"))
    assertEquals(2, o.newFailCount)
    assertTrue(o.retriable)
  }

  @Test fun anythingElseGetsTheFallbackAndNeverTheMessage() {
    val o = FailureOutcome.of(IllegalStateException("java.lang.NullPointerException at Foo.kt:12"), 0)
    assertEquals(FailureReason.FALLBACK, o.reason)
    assertFalse(o.reason.contains("NullPointer"))
  }

  @Test fun theThirdStrikeIsTheLastRetry() {
    // The sweep re-queues while fail_count < 3 (PENDING_MEETINGS_SQL). Strike 1 and 2 retry; 3 does not.
    assertTrue(FailureOutcome.of(RuntimeException(), 0).retriable)
    assertTrue(FailureOutcome.of(RuntimeException(), 1).retriable)
    val third = FailureOutcome.of(RuntimeException(), 2)
    assertEquals(3, third.newFailCount)
    assertFalse(third.retriable)
    assertFalse(FailureOutcome.of(RuntimeException(), 7).retriable)
  }

  @Test fun theStrikeLimitIsTheSweepsLimit() {
    assertEquals(3, FailureOutcome.MAX_STRIKES)
  }
}
