package com.innocorelabs.verbale.audio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

/**
 * The resampler, checked against the two things that actually matter for a transcript.
 *
 * Speech survives (a tone in the voice band comes through at the right frequency and amplitude),
 * and what cannot survive is removed rather than folded back in — a 7 kHz tone in a 48 kHz file
 * is above the 8 kHz Nyquist of our 16 kHz target only after cutoff, and naive decimation would
 * alias anything above it down INTO the voice band, where it is indistinguishable from speech.
 */
class ResamplerTest {
  private fun tone(freq: Double, rate: Int, samples: Int, amp: Float = 0.5f) =
    FloatArray(samples) { (amp * sin(2.0 * PI * freq * it / rate)).toFloat() }

  private fun rms(x: FloatArray, from: Int = 0, to: Int = x.size): Float {
    var s = 0.0
    for (i in from until to) s += x[i].toDouble() * x[i]
    return Math.sqrt(s / (to - from)).toFloat()
  }

  /** Zero crossings give the frequency back without needing an FFT in a unit test. */
  private fun crossings(x: FloatArray, from: Int, to: Int): Int {
    var n = 0
    for (i in from + 1 until to) if ((x[i - 1] < 0f) != (x[i] < 0f)) n++
    return n
  }

  @Test fun keepsAOneKilohertzToneAtTheRightRateAndLevel() {
    val seconds = 1
    val input = tone(1000.0, 48000, 48000 * seconds)
    val out = Resampler(48000, 16000).process(input, flush = true)

    assertEquals(16000.0, out.size.toDouble(), 8.0)
    // Skip the filter's start and end transients before measuring.
    assertEquals(0.5f / Math.sqrt(2.0).toFloat(), rms(out, 400, out.size - 400), 0.01f)
    // 1 kHz over the measured span, two crossings per cycle.
    val spanSec = (out.size - 800) / 16000.0
    assertEquals(2 * 1000 * spanSec, crossings(out, 400, out.size - 400).toDouble(), 4.0)
  }

  /**
   * The whole reason this is not a decimator. At 48 kHz a 15 kHz tone is legitimate; resampled to
   * 16 kHz it cannot be represented, and dropping every third sample would reflect it to 1 kHz —
   * a loud, speech-shaped whistle that whisper would happily hallucinate words out of.
   */
  @Test fun rejectsWhatWouldOtherwiseAliasIntoSpeech() {
    val input = tone(15000.0, 48000, 48000)
    val out = Resampler(48000, 16000).process(input, flush = true)
    assertTrue(
      "15 kHz survived resampling at RMS ${rms(out, 400, out.size - 400)}",
      rms(out, 400, out.size - 400) < 0.01f,
    )
  }

  @Test fun handlesTheAwkwardRatio() {
    // 44.1 kHz is not a multiple of 16 kHz: 441 input samples per 160 output.
    val input = tone(1000.0, 44100, 44100)
    val out = Resampler(44100, 16000).process(input, flush = true)
    assertEquals(16000.0, out.size.toDouble(), 8.0)
    assertEquals(0.5f / Math.sqrt(2.0).toFloat(), rms(out, 400, out.size - 400), 0.02f)
  }

  @Test fun passesAudioThroughUntouchedWhenTheRateAlreadyMatches() {
    val input = tone(440.0, 16000, 16000)
    val out = Resampler(16000, 16000).process(input, flush = true)
    assertEquals(16000.0, out.size.toDouble(), 4.0)
    assertEquals(rms(input), rms(out, 400, out.size - 400), 0.01f)
  }

  @Test fun upsamplesTooSinceAWhatsAppVoiceNoteCanBeEightKilohertz() {
    val input = tone(500.0, 8000, 8000)
    val out = Resampler(8000, 16000).process(input, flush = true)
    assertEquals(16000.0, out.size.toDouble(), 8.0)
    assertEquals(0.5f / Math.sqrt(2.0).toFloat(), rms(out, 400, out.size - 400), 0.02f)
  }

  /**
   * The property the streaming path depends on. A decoder hands us MediaCodec-sized buffers, and
   * the result has to be indistinguishable from resampling the file in one go — otherwise every
   * block boundary is a click, several thousand of them in a meeting.
   */
  @Test fun blockByBlockMatchesOneShot() {
    val input = tone(1200.0, 44100, 44100)
    val oneShot = Resampler(44100, 16000).process(input, flush = true)

    val streaming = Resampler(44100, 16000)
    val pieces = ArrayList<Float>()
    var i = 0
    // Deliberately ragged, and not a divisor of anything: real decoder output is not aligned.
    val sizes = intArrayOf(1000, 4096, 333, 8192, 77)
    var k = 0
    while (i < input.size) {
      val n = minOf(sizes[k++ % sizes.size], input.size - i)
      val block = input.copyOfRange(i, i + n)
      i += n
      val last = i >= input.size
      for (v in streaming.process(block, n, flush = last)) pieces.add(v)
    }

    assertEquals(oneShot.size, pieces.size)
    for (j in oneShot.indices) {
      assertEquals("sample $j", oneShot[j], pieces[j], 1e-6f)
    }
  }

  @Test fun producesNothingRatherThanNoiseFromAnEmptySignal() {
    val out = Resampler(48000, 16000).process(FloatArray(0), flush = true)
    assertEquals(0, out.size)
  }
}
