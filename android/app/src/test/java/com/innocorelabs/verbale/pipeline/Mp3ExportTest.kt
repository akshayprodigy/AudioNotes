package com.innocorelabs.verbale.pipeline

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** The MP3 export's rules that need no encoder: what counts as "the audio is gone", and the loop. */
class Mp3ExportTest {
  @get:Rule val tmp = TemporaryFolder()

  // ---- the audio-deleted path ---------------------------------------------------------------

  private fun pcm(bytes: Int) = tmp.newFile().apply { writeBytes(ByteArray(bytes)) }

  @Test fun theMessageIsTheOneThePersonReads() {
    assertEquals(
      "The recording for this meeting was deleted, so there is nothing to export.",
      Mp3Export.DELETED_MESSAGE,
    )
    assertEquals("AUDIO_DELETED", Mp3Export.AUDIO_DELETED)
  }

  @Test fun audioIsThereWhenRetainedAndTheFileHasBytes() {
    assertEquals(Mp3Export.AudioState.OK, Mp3Export.audioState(retained = true, file = pcm(64)))
  }

  @Test fun audioIsGoneWhenTheRetainedFlagIsOff() {
    assertEquals(Mp3Export.AudioState.DELETED, Mp3Export.audioState(retained = false, file = pcm(64)))
  }

  @Test fun audioIsGoneWhenThereIsNoPathOrNoFileOrAnEmptyFile() {
    assertEquals(Mp3Export.AudioState.DELETED, Mp3Export.audioState(true, null))
    assertEquals(Mp3Export.AudioState.DELETED, Mp3Export.audioState(true, File(tmp.root, "nope.pcm")))
    assertEquals(Mp3Export.AudioState.DELETED, Mp3Export.audioState(true, pcm(0)))
  }

  // ---- the chunked loop ---------------------------------------------------------------------

  /** Counts what it is fed and writes one byte per sample, so output size is checkable. */
  private class FakeEncoder : Mp3Encoder {
    val first = ArrayList<Short>()
    var maxSamples = 0
    var samples = 0L
    var flushed = false
    override fun encode(pcm: ShortArray, n: Int, out: ByteArray): Int {
      maxSamples = maxOf(maxSamples, n)
      if (first.isEmpty()) for (i in 0 until minOf(n, 4)) first += pcm[i]
      samples += n
      for (i in 0 until n) out[i] = 1
      return n
    }
    override fun flush(out: ByteArray): Int { flushed = true; out[0] = 9; return 1 }
  }

  /** An input that records the largest single read asked of it and never offers all at once. */
  private class Spy(private val total: Long) : InputStream() {
    var served = 0L
    var maxRead = 0
    override fun read(): Int = throw UnsupportedOperationException()
    override fun read(b: ByteArray, off: Int, len: Int): Int {
      maxRead = maxOf(maxRead, len)
      if (served >= total) return -1
      val n = minOf(len.toLong(), total - served).toInt()
      served += n
      return n
    }
  }

  @Test fun itReadsInBoundedChunksNotTheWholeFile() {
    val total = Mp3Export.CHUNK_BYTES * 10L + 1000
    val spy = Spy(total)
    val enc = FakeEncoder()
    val out = ByteArrayOutputStream()
    assertEquals(Mp3Export.Outcome.DONE, Mp3Export.encode(spy, total, enc, out, { false }, {}))
    // An ABSOLUTE bound: one that quotes CHUNK_BYTES back at itself cannot fail when CHUNK_BYTES grows.
    assertTrue("a read of ${spy.maxRead}", spy.maxRead <= 256 * 1024)
    assertTrue(enc.maxSamples <= 128 * 1024)
    assertTrue(Mp3Export.CHUNK_BYTES <= 256 * 1024)
    assertEquals(total / 2, enc.samples)
    assertTrue(enc.flushed)
    assertEquals(total / 2 + 1, out.size().toLong()) // one byte per sample, plus the flush byte
  }

  /** Little-endian, signed: 0x1234, -1, -32768, 1. A swapped byte order is loud static, not silence. */
  @Test fun samplesAreReadLittleEndianAndSigned() {
    val enc = FakeEncoder()
    val data = byteArrayOf(0x34, 0x12, -1, -1, 0x00, -0x80, 0x01, 0x00)
    Mp3Export.encode(ByteArrayInputStream(data), 8, enc, ByteArrayOutputStream(), { false }, {})
    assertEquals(listOf<Short>(0x1234, -1, Short.MIN_VALUE, 1), enc.first)
  }

  @Test fun anOddTrailingByteIsDroppedNotEncodedAsHalfASample() {
    val enc = FakeEncoder()
    val data = ByteArray(1001)
    Mp3Export.encode(ByteArrayInputStream(data), 1001, enc, ByteArrayOutputStream(), { false }, {})
    assertEquals(500L, enc.samples)
  }

  @Test fun progressRisesToExactlyOne() {
    val seen = ArrayList<Double>()
    val total = Mp3Export.CHUNK_BYTES * 5L
    Mp3Export.encode(Spy(total), total, FakeEncoder(), ByteArrayOutputStream(), { false }, { seen += it })
    assertTrue(seen.size >= 5)
    assertEquals(seen.sorted(), seen)
    assertEquals(1.0, seen.last(), 0.0)
    assertTrue(seen.first() in 0.0..0.5)
  }

  @Test fun cancelStopsTheLoopBeforeTheEndAndDoesNotFlush() {
    val total = Mp3Export.CHUNK_BYTES * 50L
    val spy = Spy(total)
    val enc = FakeEncoder()
    var chunks = 0
    val outcome = Mp3Export.encode(spy, total, enc, ByteArrayOutputStream(), { chunks++ >= 3 }, {})
    assertEquals(Mp3Export.Outcome.CANCELLED, outcome)
    assertTrue(spy.served < total)
    assertFalse(enc.flushed)
  }

  // ---- housekeeping -------------------------------------------------------------------------

  @Test fun sweepRemovesEveryStaleExport() {
    File(tmp.root, "a.mp3").writeText("x"); File(tmp.root, "b.pdf").writeText("x")
    Mp3Export.sweep(tmp.root)
    assertEquals(0, tmp.root.listFiles()!!.size)
  }

  @Test fun sweepOfAMissingDirectoryIsQuiet() {
    Mp3Export.sweep(File(tmp.root, "never-made"))
  }

  @Test fun theFilenameIsSafeAndNeverEmpty() {
    assertEquals("Q3 planning", Mp3Export.safeName("Q3 planning/../:*?"))
    assertEquals("meeting", Mp3Export.safeName("///"))
  }
}
