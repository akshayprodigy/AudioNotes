package com.innocorelabs.verbale.audio

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.sin

/**
 * Sample-rate conversion, for audio that arrives from somewhere other than our own microphone.
 *
 * Everything downstream — VAD, whisper, diarization, the player's `ms * 32` arithmetic — assumes
 * 16 kHz mono PCM16, because that is what RecordingService writes. A shared voice note is 44.1 or
 * 48 kHz stereo AAC, so something has to bridge the two, and that something has to LOW-PASS as
 * well as decimate: dropping every third sample of a 48 kHz signal folds everything above 8 kHz
 * back down into the speech band as aliasing, and the transcript degrades in a way nobody can
 * diagnose from the text.
 *
 * A windowed-sinc polyphase resampler, following Kaldi's LinearResample (the same design
 * sherpa-onnx vendors). Written here in Kotlin rather than bound to sherpa's copy because sherpa
 * is linked CONDITIONALLY — diarization is skipped when the submodule is absent — and importing a
 * file should not quietly stop working on a build that happens to lack it. It is also plain
 * arithmetic with no Android dependency, which means it is tested on the JVM rather than only on
 * a device.
 *
 * Streaming, because the alternative is not viable: an hour of 48 kHz mono as floats is 691 MB.
 */
class Resampler(
  private val inRate: Int,
  private val outRate: Int,
  /**
   * How many sinc zero-crossings the filter spans. More is sharper and slower; Kaldi suggests
   * 4–10 and uses 6 for feature extraction, which is the same job this is doing.
   */
  private val numZeros: Int = 6,
) {
  init {
    require(inRate > 0 && outRate > 0) { "sample rates must be positive" }
  }

  // 0.95 rather than 1.0 of Nyquist: a brick wall exactly at the limit needs an impractically long
  // filter, and giving up the top 400 Hz of a 16 kHz signal costs nothing for speech.
  private val cutoff = 0.95f * min(inRate, outRate) / 2f
  private val filterWidth = numZeros / (2.0 * cutoff)

  private val gcd = gcd(inRate, outRate)
  private val inPerUnit = inRate / gcd
  private val outPerUnit = outRate / gcd

  /** First input index each output-phase reads from, relative to the start of its unit. */
  private val firstIndex = IntArray(outPerUnit)
  private val weights = arrayOfNulls<FloatArray>(outPerUnit)

  // Streaming state. Absolute sample counts, so they survive across calls.
  private var inputOffset = 0L
  private var outputOffset = 0L
  private var remainder = FloatArray(0)

  init {
    for (i in 0 until outPerUnit) {
      val outputT = i.toDouble() / outRate
      val minInput = ceil((outputT - filterWidth) * inRate).toInt()
      val maxInput = floor((outputT + filterWidth) * inRate).toInt()
      firstIndex[i] = minInput
      val w = FloatArray(maxInput - minInput + 1)
      for (j in w.indices) {
        val inputT = (minInput + j).toDouble() / inRate
        // Divided by inRate so the filter's DC gain is 1: the continuous sinc integrates to 1, and
        // this is the rectangle rule for that integral at the input spacing. Without it the output
        // is scaled by the sample rate and every import clips.
        w[j] = (filterFunc(inputT - outputT) / inRate).toFloat()
      }
      weights[i] = w
    }
  }

  /** A sinc, Hanning-windowed to a finite width. */
  private fun filterFunc(t: Double): Double {
    if (abs(t) >= filterWidth) return 0.0
    val window = 0.5 * (1 + cos(PI * t / filterWidth))
    val filter = if (t == 0.0) 2.0 * cutoff else sin(2.0 * PI * cutoff * t) / (PI * t)
    return filter * window
  }

  /** Start again on a new signal. Cheap; the filter tables are not rebuilt. */
  fun reset() {
    inputOffset = 0L
    outputOffset = 0L
    remainder = FloatArray(0)
  }

  /**
   * How many output samples the signal so far can support.
   *
   * Until [flush], the last half-window of input is held back: those outputs would be computed
   * from a filter running off the end of what we have, which reads as a click.
   */
  private fun outputCount(totalInput: Long, flush: Boolean): Long {
    val tickFreq = lcm(inRate.toLong(), outRate.toLong())
    val ticksPerInput = tickFreq / inRate
    var lengthInTicks = totalInput * ticksPerInput
    if (!flush) lengthInTicks -= floor(filterWidth * tickFreq).toLong()
    if (lengthInTicks <= 0) return 0
    val ticksPerOutput = tickFreq / outRate
    var last = lengthInTicks / ticksPerOutput
    // An output landing exactly on the final tick would need the input sample after the last one.
    if (last * ticksPerOutput == lengthInTicks) last--
    return last + 1
  }

  /**
   * Resample one block. Pass `flush = true` on the last block to drain the filter's tail.
   *
   * Returns only the samples that are fully determined, so concatenating every call's result gives
   * exactly the same signal as one call with the whole input.
   */
  fun process(input: FloatArray, length: Int = input.size, flush: Boolean = false): FloatArray {
    val totalInput = inputOffset + length
    val wantedTotal = outputCount(totalInput, flush)
    val n = (wantedTotal - outputOffset).toInt()
    if (n <= 0) {
      keepTail(input, length, wantedTotal)
      return FloatArray(0)
    }

    val out = FloatArray(n)
    for (k in 0 until n) {
      val sampOut = outputOffset + k
      val phase = (sampOut % outPerUnit).toInt()
      val unit = sampOut / outPerUnit
      val first = firstIndex[phase] + unit * inPerUnit
      val w = weights[phase]!!
      var sum = 0f
      for (j in w.indices) {
        val idx = first + j
        // Before the signal starts and past its end are both silence — the only honest answer,
        // and what makes the flush tail decay rather than repeat the last sample.
        if (idx < 0 || idx >= totalInput) continue
        val rel = idx - inputOffset
        sum += w[j] * if (rel >= 0) input[rel.toInt()] else remainder[(rel + remainder.size).toInt()]
      }
      out[k] = sum
    }
    outputOffset = wantedTotal
    keepTail(input, length, wantedTotal)
    return out
  }

  /**
   * Hold on to the input the NEXT output samples will still need.
   *
   * The filter reaches backwards, so the first input sample the next call reads is generally
   * behind the end of this block. Dropping it would put a discontinuity at every block boundary.
   */
  private fun keepTail(input: FloatArray, length: Int, producedTotal: Long) {
    val nextPhase = (producedTotal % outPerUnit).toInt()
    val nextUnit = producedTotal / outPerUnit
    val firstNeeded = firstIndex[nextPhase] + nextUnit * inPerUnit
    val totalInput = inputOffset + length
    val keepFrom = if (firstNeeded < 0) 0L else min(firstNeeded, totalInput)
    val keep = (totalInput - keepFrom).toInt()

    val tail = FloatArray(keep)
    for (i in 0 until keep) {
      val idx = keepFrom + i
      val rel = idx - inputOffset
      tail[i] = if (rel >= 0) input[rel.toInt()] else remainder[(rel + remainder.size).toInt()]
    }
    remainder = tail
    inputOffset = totalInput
  }

  private companion object {
    fun gcd(a: Int, b: Int): Int = if (b == 0) a else gcd(b, a % b)
    fun lcm(a: Long, b: Long): Long = a / gcdL(a, b) * b
    fun gcdL(a: Long, b: Long): Long = if (b == 0L) a else gcdL(b, a % b)
  }
}
