package com.innocorelabs.verbale.pipeline

import android.os.PowerManager

/**
 * Whether post-hoc processing should stop for a while.
 *
 * Sibling of [LiveBudget], which asks the same question of the live pass and answers "back off"
 * — a cache can be skipped. The post-hoc pipeline cannot: it pauses between units of work and
 * carries on when the phone has recovered. Every threshold is one phone's first guess; each
 * pause and resume is logged with its numbers (ProcessingEngine) so the next phone can argue.
 */
object ProcessingBudget {
  /** Unplugged and below this, stop; the phone needs what is left more than the notes do. */
  const val PAUSE_BATTERY_BELOW = 15
  /** …and do not start again until here, so the line is not crossed twice a minute. */
  const val RESUME_BATTERY_AT = 20
  /** How often a paused pipeline asks again. */
  const val POLL_MS = 5_000L

  enum class PauseReason { HEAT, BATTERY }

  /**
   * Why to be paused now, or null to run. [paused] is the reason currently in force, which is
   * what makes the battery band a band; heat has no band because SEVERE and MODERATE are
   * adjacent statuses. SEVERE, never MODERATE: a Pixel reads MODERATE on a desk while charging.
   */
  fun reasonToPause(thermal: Int, batteryPercent: Int, charging: Boolean, paused: PauseReason?): PauseReason? {
    if (thermal >= PowerManager.THERMAL_STATUS_SEVERE) return PauseReason.HEAT
    val floor = if (paused == PauseReason.BATTERY) RESUME_BATTERY_AT else PAUSE_BATTERY_BELOW
    if (!charging && batteryPercent < floor) return PauseReason.BATTERY
    return null
  }
}
