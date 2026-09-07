package com.innocorelabs.verbale.pipeline

import android.os.PowerManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The policy, separated from the Android services that supply its inputs so it can be tested.
 *
 * Every decision here leans the same way: when in doubt, do not run. Backing off costs speed and
 * nothing else, because the post-hoc pass picks up whatever was missed — but starving the capture
 * or flattening the battery costs the meeting, which is the irreplaceable thing.
 */
class LiveBudgetTest {
  @Test
  fun starts_when_there_is_room() {
    assertTrue(LiveBudget.mayStart(availableBytes = 900L * 1024 * 1024))
  }

  @Test
  fun refuses_when_memory_is_tight() {
    // whisper resident costs ~200 MB and the claim is half of free, so 150 MB free is far short.
    assertFalse(LiveBudget.mayStart(availableBytes = 150L * 1024 * 1024))
    assertFalse(LiveBudget.mayStart(availableBytes = 0L))
    // availMem can come back below the threshold, making this negative. Not an error, just no.
    assertFalse(LiveBudget.mayStart(availableBytes = -1L))
  }

  @Test
  fun backs_off_when_hot() {
    assertFalse(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_NONE, 80, charging = false))
    assertFalse(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_LIGHT, 80, charging = false))
    // MODERATE must NOT back off, and this assertion is the whole finding. A Pixel 7 Pro on a
    // desk, plugged in at 100% and 39.9 C after half an hour of transcribing, reads MODERATE —
    // an ordinary state. Backing off there switched the feature off for a whole recording, and
    // for exactly the case it exists to serve, since people plug in for long meetings.
    assertFalse(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_MODERATE, 80, charging = false))
    // SEVERE is where Android says the user experience is largely impacted. A background
    // optimisation yields there.
    assertTrue(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_SEVERE, 80, charging = false))
    assertTrue(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_CRITICAL, 80, charging = false))
  }

  @Test
  fun backs_off_when_the_battery_is_low_unless_charging() {
    assertTrue(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_NONE, 15, charging = false))
    // On a charger a low battery is not a reason to stop: it is going up, not down.
    assertFalse(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_NONE, 15, charging = true))
    // Heat is a reason to stop even on a charger — charging is part of why it is hot.
    assertTrue(LiveBudget.shouldBackOff(PowerManager.THERMAL_STATUS_SEVERE, 100, charging = true))
  }

  @Test
  fun the_low_battery_boundary_is_inclusive_below_and_exclusive_at() {
    assertTrue(LiveBudget.shouldBackOff(0, LiveBudget.LOW_BATTERY_PERCENT - 1, charging = false))
    assertFalse(LiveBudget.shouldBackOff(0, LiveBudget.LOW_BATTERY_PERCENT, charging = false))
  }

  @Test
  fun yields_while_the_pipeline_is_working() {
    // One heavy job at a time. Measured on a Pixel 7 Pro: a live pass running against a previous
    // meeting still in ASR cached 6 windows of the 11 its recording held, while the pipeline's
    // own ASR fell from 0.35x to 0.85x realtime. Both halves lost.
    assertTrue(LiveBudget.shouldBackOff(
      PowerManager.THERMAL_STATUS_NONE, 100, charging = true, pipelineBusy = true,
    ))
    assertFalse(LiveBudget.shouldBackOff(
      PowerManager.THERMAL_STATUS_NONE, 100, charging = true, pipelineBusy = false,
    ))
    // It outranks nothing else — a hot phone still stops for heat, busy or not.
    assertTrue(LiveBudget.shouldBackOff(
      PowerManager.THERMAL_STATUS_SEVERE, 100, charging = true, pipelineBusy = false,
    ))
  }

  @Test
  fun thread_count_leaves_the_capture_headroom() {
    assertEquals(1, LiveBudget.threadsFor(1))
    assertEquals(1, LiveBudget.threadsFor(2))
    assertEquals(3, LiveBudget.threadsFor(4))
    // A nonsense count must never produce zero threads.
    assertEquals(1, LiveBudget.threadsFor(0))
  }
}
