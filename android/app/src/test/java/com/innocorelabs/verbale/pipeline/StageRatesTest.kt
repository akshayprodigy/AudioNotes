package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The rate a stage leaves behind for the next ETA. The defect it guards: an ETA priced from one
 * Pixel's constants on every phone, and — once rates are learned — one odd run (a hot phone, a
 * live-pass cache that skipped most of ASR, a 10-second test recording) owning the number.
 */
class StageRatesTest {
  @Test fun theFirstRunIsTakenAsIs() {
    assertEquals(0.40, StageRates.next(previous = null, measured = 0.40, audioMs = 300_000L)!!, 1e-9)
  }

  @Test fun aLaterRunIsBlendedTowardsTheNewNumber() {
    // 0.7 × 0.20 + 0.3 × 0.40 = 0.26
    assertEquals(0.26, StageRates.next(previous = 0.40, measured = 0.20, audioMs = 300_000L)!!, 1e-9)
  }

  @Test fun aRecordingUnderThirtySecondsTeachesNothing() {
    assertNull(StageRates.next(previous = 0.40, measured = 0.05, audioMs = 29_999L))
    assertEquals(0.40, StageRates.next(previous = null, measured = 0.40, audioMs = 30_000L)!!, 1e-9)
  }

  @Test fun aNonsenseMeasurementTeachesNothing() {
    assertNull(StageRates.next(previous = 0.40, measured = 0.0, audioMs = 300_000L))
    assertNull(StageRates.next(previous = 0.40, measured = Double.NaN, audioMs = 300_000L))
    assertNull(StageRates.next(previous = 0.40, measured = Double.POSITIVE_INFINITY, audioMs = 300_000L))
  }

  @Test fun aBrokenStoredValueIsReplacedNotBlended() {
    assertEquals(0.20, StageRates.next(previous = -1.0, measured = 0.20, audioMs = 300_000L)!!, 1e-9)
  }

  @Test fun theKeyIsNamespacedSoTheQueryCanFindEveryStageAtOnce() {
    assertEquals("rate.asr", StageRates.key("asr"))
  }

  /**
   * A thermal pause is wall time, not work. On the Pixel the first run's diarization stage sat
   * paused for 110 s of a 335 s meeting and would have taught 0.33x of pure waiting.
   */
  @Test fun timeSpentPausedIsNotTheStagesSpeed() {
    assertEquals(0.30, StageRates.measured(stageMs = 210_500L, pausedMs = 110_000L, audioMs = 335_000L), 1e-9)
    assertEquals(0.0, StageRates.measured(stageMs = 5_000L, pausedMs = 9_000L, audioMs = 335_000L), 1e-9)
    assertEquals(0.0, StageRates.measured(stageMs = 5_000L, pausedMs = 0L, audioMs = 0L), 1e-9)
  }
}
