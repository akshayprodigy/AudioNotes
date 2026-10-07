package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.pipeline.PausePolicy.Action
import org.junit.Assert.assertEquals
import org.junit.Test

class PausePolicyTest {
  private val min = 60_000L

  @Test fun `the numbers are thirty minutes to ask and sixty to end`() {
    assertEquals(30 * min, PausePolicy.ASK_AFTER_MS)
    assertEquals(60 * min, PausePolicy.END_AFTER_MS)
  }

  @Test fun `a short pause is left alone`() {
    assertEquals(Action.NONE, PausePolicy.action(0L))
    assertEquals(Action.NONE, PausePolicy.action(30 * min - 1))
  }

  @Test fun `half an hour asks, and the ask holds until the hour`() {
    assertEquals(Action.ASK, PausePolicy.action(30 * min))
    assertEquals(Action.ASK, PausePolicy.action(60 * min - 1))
  }

  @Test fun `an hour ends it`() {
    assertEquals(Action.END, PausePolicy.action(60 * min))
    assertEquals(Action.END, PausePolicy.action(5 * 60 * min))
  }
}
