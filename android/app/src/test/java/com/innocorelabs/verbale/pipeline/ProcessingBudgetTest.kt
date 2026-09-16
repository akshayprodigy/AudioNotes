package com.innocorelabs.verbale.pipeline

import android.os.PowerManager
import com.innocorelabs.verbale.pipeline.ProcessingBudget.PauseReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * When post-hoc processing stops to let the phone recover, and when it may go on. The defects
 * it guards: pausing at MODERATE (the Pixel's ordinary state on a desk while charging — the
 * LiveBudget lesson), and a battery pause that flaps at the line.
 */
class ProcessingBudgetTest {
  private fun why(thermal: Int, battery: Int, charging: Boolean, paused: PauseReason? = null) =
    ProcessingBudget.reasonToPause(thermal, battery, charging, paused)

  @Test fun severeHeatPausesAndModerateDoesNot() {
    assertEquals(PauseReason.HEAT, why(PowerManager.THERMAL_STATUS_SEVERE, 80, true))
    assertNull(why(PowerManager.THERMAL_STATUS_MODERATE, 80, true))
    assertNull(why(PowerManager.THERMAL_STATUS_LIGHT, 80, false))
  }

  @Test fun aHeatPauseLiftsAtModerate() {
    assertEquals(PauseReason.HEAT, why(PowerManager.THERMAL_STATUS_SEVERE, 80, true, paused = PauseReason.HEAT))
    assertNull(why(PowerManager.THERMAL_STATUS_MODERATE, 80, true, paused = PauseReason.HEAT))
  }

  @Test fun aFlatBatteryPausesOnlyWhenUnplugged() {
    assertEquals(PauseReason.BATTERY, why(PowerManager.THERMAL_STATUS_NONE, 14, false))
    assertNull(why(PowerManager.THERMAL_STATUS_NONE, 14, true))
    assertNull(why(PowerManager.THERMAL_STATUS_NONE, 15, false))
  }

  @Test fun aBatteryPauseHoldsUntilTwentyPercentOrACharger() {
    assertEquals(PauseReason.BATTERY, why(PowerManager.THERMAL_STATUS_NONE, 17, false, paused = PauseReason.BATTERY))
    assertNull(why(PowerManager.THERMAL_STATUS_NONE, 20, false, paused = PauseReason.BATTERY))
    assertNull(why(PowerManager.THERMAL_STATUS_NONE, 17, true, paused = PauseReason.BATTERY))
  }

  @Test fun heatOutranksBattery() {
    assertEquals(PauseReason.HEAT, why(PowerManager.THERMAL_STATUS_CRITICAL, 5, false))
  }
}
