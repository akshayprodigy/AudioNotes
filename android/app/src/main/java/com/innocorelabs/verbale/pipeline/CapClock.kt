package com.innocorelabs.verbale.pipeline

import java.util.Locale

/**
 * The free tier's length limit, as the surfaces outside the app show it.
 *
 * The record screen has its own card for the last three minutes; the PiP window and the recording
 * notification are what a person sees when the app is NOT in front, which is how most meetings
 * are recorded. They change at the same second the card does: WARN_BEFORE_MS mirrors
 * WARN_BEFORE_MS in src/billing/recordingCap.ts, and if one moves the other moves in the same
 * commit.
 *
 * Pure: no clock, no Android. The capture loop and the PiP view pass the numbers in.
 */
object CapClock {
  /** Mirrors WARN_BEFORE_MS in src/billing/recordingCap.ts. */
  const val WARN_BEFORE_MS = 3 * 60_000L

  /** The last minute, when the warning turns red. */
  const val FINAL_MS = 60_000L

  enum class Phase { UNCAPPED, QUIET, WARNING, FINAL }

  fun phase(elapsedMs: Long, capMs: Long): Phase {
    if (capMs <= 0L) return Phase.UNCAPPED
    val left = capMs - elapsedMs
    return when {
      left <= FINAL_MS -> Phase.FINAL
      left <= WARN_BEFORE_MS -> Phase.WARNING
      else -> Phase.QUIET
    }
  }

  fun remainingMs(elapsedMs: Long, capMs: Long): Long = (capMs - elapsedMs).coerceAtLeast(0L)

  /** "04:12" — the clock as the PiP window has always drawn it. */
  private fun clock(ms: Long): String {
    val s = (ms / 1000L).coerceAtLeast(0L)
    return String.format(Locale.ROOT, "%02d:%02d", s / 60, s % 60)
  }

  /** "2:48" — rounded UP, so the countdown never says a second less than there is. */
  private fun countdown(ms: Long): String {
    val s = (ms.coerceAtLeast(0L) + 999L) / 1000L
    return String.format(Locale.ROOT, "%d:%02d", s / 60, s % 60)
  }

  /** What the PiP window prints under the microphone. */
  fun pipLabel(elapsedMs: Long, capMs: Long): String = when (phase(elapsedMs, capMs)) {
    Phase.UNCAPPED -> clock(elapsedMs)
    Phase.QUIET -> "${clock(elapsedMs)} / ${clock(capMs)}"
    Phase.WARNING, Phase.FINAL -> "${countdown(remainingMs(elapsedMs, capMs))} left on Free"
  }

  /** The warning phases, where a purchase can still lift the limit and the surfaces count down. */
  fun counting(phase: Phase): Boolean = phase == Phase.WARNING || phase == Phase.FINAL
}
