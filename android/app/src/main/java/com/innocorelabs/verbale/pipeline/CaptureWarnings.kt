package com.innocorelabs.verbale.pipeline

import java.util.ArrayDeque

/**
 * The three things the record screen may warn about while a meeting is being captured, and the
 * arithmetic behind each. Pure: no Android, no state — CaptureController owns the state and the
 * capture loop feeds it. Nothing here blocks or pauses anything; a warning is a sentence on the
 * screen and in the notification, and the recording is the thing being protected.
 *
 * Every threshold is a first guess. The capture loop logs each transition with the numbers that
 * caused it (CaptureController.refreshWarning), which is how the next phone argues with them —
 * the same discipline as the announcement verifier's thresholds.
 */
object CaptureWarnings {
  /** Fraction of samples at full scale, over the last two seconds, above which the input is clipping. */
  const val CLIP_FRACTION = 0.01

  /** Mean RMS during speech (0..1) below which voices are "faint": −54 dBFS. The A07's meeting at −48 transcribed cleanly. */
  const val FAINT_RMS = 0.002

  /** Faint needs this much speech in the last minute before it is a judgement rather than a guess. */
  const val FAINT_MIN_SPEECH_MS = 10_000L

  enum class Kind { STORAGE, LOUD, FAINT }

  data class Warning(val kind: Kind, val minutesLeft: Long)

  /** Samples at (or within one step of) full scale, as a fraction of [n]. Two-byte little-endian PCM in a ShortArray. */
  fun clippedFraction(buf: ShortArray, n: Int): Double {
    if (n <= 0) return 0.0
    var clipped = 0
    for (i in 0 until n) {
      val v = buf[i].toInt()
      if (v >= Short.MAX_VALUE - 1 || v <= Short.MIN_VALUE + 1) clipped++
    }
    return clipped.toDouble() / n
  }

  fun isFaint(speechMs: Long, meanRmsDuringSpeech: Double): Boolean =
    speechMs >= FAINT_MIN_SPEECH_MS && meanRmsDuringSpeech < FAINT_RMS

  /** Whole minutes of capture the free space can hold at 32 bytes per ms. */
  fun minutesLeft(freeBytes: Long): Long = freeBytes / (RecordingService.BYTES_PER_MS.toLong() * 60_000L)

  /** One warning at a time: storage, then loud, then faint. Null when none applies. */
  fun pick(storageMinutesLeft: Long, loud: Boolean, faint: Boolean, storageWarnAtMinutes: Long): Warning? = when {
    storageMinutesLeft < storageWarnAtMinutes -> Warning(Kind.STORAGE, storageMinutesLeft)
    loud -> Warning(Kind.LOUD, storageMinutesLeft)
    faint -> Warning(Kind.FAINT, storageMinutesLeft)
    else -> null
  }
}

/**
 * Per-buffer RMS, stamped on the capture clock, kept for [windowMs] behind the newest sample.
 * `meanIn` averages the samples that fall inside any of the given [start, end) spans — the live
 * VAD's speech spans — so "how loud were the voices" is asked of speech only, not of the room.
 */
class RmsRing(private val windowMs: Long) {
  private val samples = ArrayDeque<Pair<Long, Double>>()

  @Synchronized
  fun add(atMs: Long, rms: Double) {
    samples.addLast(atMs to rms)
    while (samples.isNotEmpty() && samples.first.first < atMs - windowMs) samples.removeFirst()
  }

  @Synchronized
  fun meanIn(spans: List<Pair<Long, Long>>): Double {
    var sum = 0.0
    var n = 0
    for ((at, rms) in samples) {
      if (spans.any { at >= it.first && at < it.second }) { sum += rms; n++ }
    }
    return if (n == 0) 0.0 else sum / n
  }
}

/** Per-buffer clipped fractions over the last [windowMs]; "loud" is their mean, not one hot buffer. */
class ClipWindow(private val windowMs: Long) {
  private val samples = ArrayDeque<Pair<Long, Double>>()

  @Synchronized
  fun add(atMs: Long, fraction: Double) {
    samples.addLast(atMs to fraction)
    while (samples.isNotEmpty() && samples.first.first < atMs - windowMs) samples.removeFirst()
  }

  @Synchronized
  fun mean(): Double = if (samples.isEmpty()) 0.0 else samples.sumOf { it.second } / samples.size
}
