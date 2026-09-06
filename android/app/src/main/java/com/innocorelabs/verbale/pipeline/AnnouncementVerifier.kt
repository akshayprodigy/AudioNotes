package com.innocorelabs.verbale.pipeline

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Asks the recording whether the room was told, instead of asking the media player whether it
 * finished playing. Those are not the same question.
 *
 * Six recordings on one Pixel 7 Pro on 6 September 2026 settled it. In every one, playback
 * completed identically: all 72076 frames delivered, routing on AUDIO_DEVICE_OUT_SPEAKER,
 * onCompletion fired, nothing in logcat. In two, the disclosure was the transcript's first line.
 * In three, the clip reached the microphone so far below the room that the pipeline returned "no
 * speech found" — present in the file, useless as evidence. In the last, the setting was off and
 * the clip was genuinely absent.
 *
 * What varies is the LEVEL, and it varies with physical things Android never reports: how the
 * phone is lying, what is resting over the speaker. So `announced_at` cannot be written on the
 * player's word.
 *
 * Two questions, in order, because they fail differently:
 *
 *  1. **Is this clip in the recording at all?** Answered by normalised cross-correlation of the
 *     waveform against the bundled clip. A speaker playing into a room and back through a
 *     microphone mangles level and frequency response, but the waveform survives well enough to
 *     correlate — this is the same principle an echo canceller uses to find its own output. It is
 *     also what stops a person talking loudly over the opening seconds from being mistaken for an
 *     announcement: a voice does not correlate with this clip.
 *
 *  2. **Was it loud enough to be evidence?** Answered by comparing loudness inside the matched
 *     window against the rest of the recording. A disclosure buried under room noise is not proof
 *     to anybody: it will not survive the transcript, and the transcript is what travels with the
 *     exported file.
 *
 * Both must hold. When they do not, the meeting simply goes unstamped — under-claiming is safe and
 * visible, while a consent record for a room that was told nothing is the defect this removes.
 */
object AnnouncementVerifier {

  /** 10 ms at 16 kHz, for the loudness envelope. The committed fixtures use this hop. */
  const val HOP = 160

  /** 16 kHz to 2 kHz for the correlation search. Speech structure survives; the cost drops 64x. */
  const val DECIMATE = 8

  /** How far in the clip may start. It is played right after startRecording(), or not at all. */
  const val MAX_START_SECONDS = 2.0f

  /**
   * How far the correlation peak must stand above the rest of the search, to call the clip present.
   *
   * Measured: the recording where the announcement was switched off scored 1.04 — no peak, which
   * is what absent looks like. The five where it played scored 2.58, 4.67, 5.95, 8.54 and 9.91.
   */
  const val MIN_PEAK_OVER_BACKGROUND = 2.0f

  /**
   * How much louder the clip must be than the rest of the meeting, to call it evidence.
   *
   * Measured: the two whose transcripts opened with the disclosure scored 1.57 and 3.51. The three
   * that came back unusable — the clip present but under the room — scored 1.01, 1.09 and 1.33.
   */
  const val MIN_LOUDNESS_RATIO = 1.40f

  /** Where the clip was found, and how strongly. */
  data class Match(val lagFrames: Int, val peakOverBackground: Float)

  /** RMS of each 10 ms frame. A trailing partial frame is dropped. */
  fun envelope(pcm: ShortArray, hop: Int = HOP): FloatArray {
    val frames = pcm.size / hop
    return FloatArray(frames) { f ->
      var sum = 0.0
      val base = f * hop
      for (i in 0 until hop) {
        val v = pcm[base + i].toDouble()
        sum += v * v
      }
      sqrt(sum / hop).toFloat()
    }
  }

  /**
   * Locate the clip in the capture's opening seconds, or null when it is not there.
   *
   * The returned lag is in 10 ms envelope frames, so it can be handed straight to
   * [loudnessRatio] without either caller converting units.
   */
  fun findClip(capture: ShortArray, clip: ShortArray): Match? {
    val x = decimate(capture)
    val c = decimate(clip)
    if (c.size < 200 || x.size <= c.size) return null

    val cz = centred(c, 0, c.size) ?: return null
    val rate = 16000 / DECIMATE
    val maxLag = minOf(x.size - c.size, (MAX_START_SECONDS * rate).toInt())
    if (maxLag < 2) return null

    val r = FloatArray(maxLag)
    for (lag in 0 until maxLag) {
      val wz = centred(x, lag, c.size)
      if (wz == null) continue
      var dot = 0f
      for (i in cz.indices) dot += wz[i] * cz[i]
      r[lag] = abs(dot)
    }

    var peak = 0
    for (i in r.indices) if (r[i] > r[peak]) peak = i
    if (r[peak] <= 0f) return null

    // Background: the best score anywhere well away from the peak. A real match towers over it;
    // a coincidence sits in it.
    val guard = rate / 2
    var background = 0f
    for (i in r.indices) if (abs(i - peak) > guard && r[i] > background) background = r[i]
    if (background <= 0f) return null

    val lagSeconds = peak.toFloat() / rate
    return Match(
      lagFrames = (lagSeconds * (16000 / HOP)).toInt(),
      peakOverBackground = r[peak] / background,
    )
  }

  /** Loudness inside the matched window against everything outside it. */
  fun loudnessRatio(captureEnvelope: FloatArray, clipFrames: Int, lagFrames: Int): Float {
    val from = lagFrames.coerceAtLeast(0)
    val to = (from + clipFrames).coerceAtMost(captureEnvelope.size)
    if (to - from < clipFrames / 2) return 0f

    var inSum = 0.0
    for (i in from until to) inSum += captureEnvelope[i]
    var outSum = 0.0
    var outN = 0
    for (i in captureEnvelope.indices) {
      if (i < from || i >= to) {
        outSum += captureEnvelope[i]
        outN++
      }
    }
    if (outN == 0) return 0f
    val inMean = inSum / (to - from)
    if (inMean < 1.0) return 0f
    return (inMean / maxOf(outSum / outN, 1e-9)).toFloat()
  }

  /** True only when the clip is present AND loud enough to be evidence. */
  fun heardIn(capture: ShortArray, clip: ShortArray): Boolean = describe(capture, clip).heard

  /** The verdict with the numbers behind it, so a device run can be read rather than guessed at. */
  data class Verdict(
    val heard: Boolean,
    val found: Boolean,
    val peakOverBackground: Float,
    val loudnessRatio: Float,
    val lagFrames: Int,
  ) {
    override fun toString(): String =
      "heard=$heard found=$found peak/bg=%.2f loudness=%.2f lag=%dms"
        .format(peakOverBackground, loudnessRatio, lagFrames * 10)
  }

  fun describe(capture: ShortArray, clip: ShortArray): Verdict {
    val match = findClip(capture, clip)
      ?: return Verdict(false, false, 0f, 0f, -1)
    if (match.peakOverBackground < MIN_PEAK_OVER_BACKGROUND) {
      return Verdict(false, false, match.peakOverBackground, 0f, match.lagFrames)
    }
    val ratio = loudnessRatio(envelope(capture), clip.size / HOP, match.lagFrames)
    return Verdict(
      heard = ratio >= MIN_LOUDNESS_RATIO,
      found = true,
      peakOverBackground = match.peakOverBackground,
      loudnessRatio = ratio,
      lagFrames = match.lagFrames,
    )
  }

  private fun decimate(pcm: ShortArray): FloatArray {
    val n = pcm.size / DECIMATE
    return FloatArray(n) { f ->
      var sum = 0f
      val base = f * DECIMATE
      for (i in 0 until DECIMATE) sum += pcm[base + i]
      sum / DECIMATE
    }
  }

  /** Mean-removed and unit-norm, or null when the slice is flat and correlates with nothing. */
  private fun centred(x: FloatArray, from: Int, len: Int): FloatArray? {
    var sum = 0.0
    for (i in from until from + len) sum += x[i]
    val mean = (sum / len).toFloat()
    var norm = 0.0
    for (i in from until from + len) {
      val d = x[i] - mean
      norm += d.toDouble() * d
    }
    val n = sqrt(norm).toFloat()
    if (n < 1e-6f) return null
    return FloatArray(len) { (x[from + it] - mean) / n }
  }
}
