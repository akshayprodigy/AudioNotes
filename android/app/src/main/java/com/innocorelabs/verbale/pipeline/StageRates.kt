package com.innocorelabs.verbale.pipeline

/**
 * What a finished stage teaches the ETA about this phone.
 *
 * The screen prices the wait from seconds-of-work per second-of-audio. Those numbers shipped as
 * one Pixel's measurements; here each phone learns its own, one stage at a time, in `settings`
 * under [key]. Blended rather than replaced so one odd run — a hot phone, a live-pass cache
 * that skipped most of ASR — moves the number rather than owning it.
 */
object StageRates {
  /** Under this, the stage was over before it could be timed. */
  const val MIN_AUDIO_MS = 30_000L

  /** How much of the new number survives the blend. */
  const val WEIGHT_NEW = 0.7

  fun key(stage: String): String = "rate.$stage"

  /**
   * The value to store, or null when this run says nothing worth keeping. [measured] is
   * stage milliseconds over audio milliseconds; [previous] is what `settings` holds, if anything.
   */
  fun next(previous: Double?, measured: Double, audioMs: Long): Double? {
    if (audioMs < MIN_AUDIO_MS) return null
    if (measured.isNaN() || measured.isInfinite() || measured <= 0.0) return null
    val usable = previous != null && !previous.isNaN() && !previous.isInfinite() && previous > 0.0
    return if (usable) WEIGHT_NEW * measured + (1.0 - WEIGHT_NEW) * previous!! else measured
  }
}
