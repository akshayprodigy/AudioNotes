package com.innocorelabs.verbale

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Debug
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.pipeline.LameEncoder
import com.innocorelabs.verbale.pipeline.Mp3Export
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The real encoder, on the phone: LAME through the JNI shim, decoded again by Android's own MP3
 * decoder. Not a JVM test — it needs libmp3lame.so for the phone's ABI.
 *
 * A known tone goes in; what must come out is the same length and the same pitch. A codec that
 * encodes silence, the wrong rate (chipmunk or slow-motion) or the wrong byte order fails here and
 * nowhere else: the JVM tests only prove the loop, with a fake encoder.
 */
@RunWith(AndroidJUnit4::class)
class Mp3EncoderTest {
  private val rate = 16000

  /** A sine of [hz] and [seconds], as the headerless PCM16 a recording is, produced lazily. */
  private class Tone(private val hz: Double, seconds: Long, private val rate: Int) : InputStream() {
    private val total = seconds * rate * 2
    private var served = 0L
    override fun read(): Int = throw UnsupportedOperationException()
    override fun read(b: ByteArray, off: Int, len: Int): Int {
      if (served >= total) return -1
      val n = minOf(len.toLong(), total - served).toInt() and 1.inv()
      var i = 0
      while (i < n) {
        val sample = (sin(2 * PI * hz * ((served + i) / 2) / rate) * 12000).toInt().toShort()
        b[off + i] = (sample.toInt() and 0xFF).toByte()
        b[off + i + 1] = (sample.toInt() shr 8).toByte()
        i += 2
      }
      served += n
      return n
    }
  }

  private fun encodeTone(hz: Double, seconds: Long): File {
    val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    val f = File(ctx.cacheDir, "tone-$hz.mp3")
    LameEncoder("Tone", "2026", "test").use { enc ->
      f.outputStream().buffered().use { out ->
        Mp3Export.encode(Tone(hz, seconds, rate), seconds * rate * 2, enc, out, { false }, {})
      }
    }
    return f
  }

  /** Decode with the platform codec: mono PCM16 samples and the sample rate it reports. */
  private fun decode(f: File): Pair<ShortArray, Int> {
    val ex = MediaExtractor().apply { setDataSource(f.absolutePath) }
    ex.selectTrack(0)
    val fmt = ex.getTrackFormat(0)
    val codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME)!!)
    codec.configure(fmt, null, null, 0)
    codec.start()
    val pcm = ByteArrayOutputStream()
    val info = MediaCodec.BufferInfo()
    var inDone = false
    var outDone = false
    var outRate = fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE)
    var channels = fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
    while (!outDone) {
      if (!inDone) {
        val i = codec.dequeueInputBuffer(10_000)
        if (i >= 0) {
          val n = ex.readSampleData(codec.getInputBuffer(i)!!, 0)
          if (n < 0) {
            codec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inDone = true
          } else {
            codec.queueInputBuffer(i, 0, n, ex.sampleTime, 0); ex.advance()
          }
        }
      }
      val o = codec.dequeueOutputBuffer(info, 10_000)
      if (o >= 0) {
        val buf = codec.getOutputBuffer(o)!!
        val bytes = ByteArray(info.size).also { buf.get(it) }
        pcm.write(bytes)
        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outDone = true
        codec.releaseOutputBuffer(o, false)
      } else if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
        outRate = codec.outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        channels = codec.outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      }
    }
    codec.stop(); codec.release(); ex.release()
    val raw = pcm.toByteArray()
    val all = ShortArray(raw.size / 2) { ((raw[2 * it].toInt() and 0xFF) or (raw[2 * it + 1].toInt() shl 8)).toShort() }
    assertEquals("the MP3 must be mono", 1, channels)
    return all to outRate
  }

  /** Energy of one frequency over a window (Goertzel). */
  private fun power(x: ShortArray, from: Int, len: Int, hz: Double, rate: Int): Double {
    val w = 2 * cos(2 * PI * hz / rate)
    var s1 = 0.0; var s2 = 0.0
    for (i in from until from + len) { val s = x[i] + w * s1 - s2; s2 = s1; s1 = s }
    return s1 * s1 + s2 * s2 - w * s1 * s2
  }

  private fun dominantHz(x: ShortArray, rate: Int): Double {
    val from = x.size / 2 - rate / 2
    var best = 0.0; var bestHz = 0.0
    var hz = 100.0
    while (hz <= 4000.0) {
      val p = power(x, from, rate, hz, rate)
      if (p > best) { best = p; bestHz = hz }
      hz += 10.0
    }
    return bestHz
  }

  @Test fun aKnownToneComesBackTheSameLengthAndThePitch() {
    for (hz in listOf(440.0, 1000.0)) {
      val seconds = 20L
      val f = encodeTone(hz, seconds)
      val (pcm, outRate) = decode(f)
      val durationS = pcm.size.toDouble() / outRate
      assertEquals("duration of $hz Hz", seconds.toDouble(), durationS, 0.3)
      assertEquals("dominant frequency", hz, dominantHz(pcm, outRate), 20.0)
      // 64 kbps = 8000 bytes a second, plus the ID3 tag and the encoder's delay.
      assertEquals("size", seconds * 8000.0, f.length().toDouble(), 6000.0)
      f.delete()
    }
  }

  @Test fun theTagCarriesTheTitleAndTheDate() {
    val f = encodeTone(1000.0, 2)
    val head = f.inputStream().use { ins -> ByteArray(2048).also { ins.read(it) } }
    val text = String(head, Charsets.ISO_8859_1)
    assertTrue("ID3v2 header", text.startsWith("ID3"))
    assertTrue("title", text.contains("Tone"))
    assertTrue("year", text.contains("2026"))
    f.delete()
  }

  /** A sink that keeps only a count, so the test itself holds nothing. */
  private class Counting : OutputStream() {
    var n = 0L
    override fun write(b: Int) { n++ }
    override fun write(b: ByteArray, off: Int, len: Int) { n += len }
  }

  @Test fun anHourOfAudioStaysInsideAMemoryBound() {
    val seconds = 3600L
    System.gc()
    val rt = Runtime.getRuntime()
    val heap0 = rt.totalMemory() - rt.freeMemory()
    val native0 = Debug.getNativeHeapAllocatedSize()
    var worstHeap = 0L
    var worstNative = 0L
    val out = Counting()
    LameEncoder("Long", "2026", "test").use { enc ->
      Mp3Export.encode(Tone(700.0, seconds, rate), seconds * rate * 2, enc, out, { false }) {
        worstHeap = maxOf(worstHeap, rt.totalMemory() - rt.freeMemory() - heap0)
        worstNative = maxOf(worstNative, Debug.getNativeHeapAllocatedSize() - native0)
      }
    }
    // The input is 115 MB of PCM; the output ~28 MB. Anything that buffered either would blow this.
    val mb = 1024 * 1024
    assertTrue("heap grew ${worstHeap / mb} MB", worstHeap < 24 * mb)
    assertTrue("native heap grew ${worstNative / mb} MB", worstNative < 24 * mb)
    assertEquals("an hour at 64 kbps is ~28 MB", 28.8e6, out.n.toDouble(), 1.5e6)
    assertTrue(abs(out.n - 28_800_000L) < 1_500_000L)
  }
}
