package com.innocorelabs.verbale.pipeline

import java.io.File
import java.io.InputStream
import java.io.OutputStream

/** Turns blocks of 16-bit samples into MP3 bytes. LAME on the phone ([LameEncoder]); a fake in tests. */
interface Mp3Encoder {
  /** Encode the first [n] samples of [pcm] into [out]; returns the bytes written. */
  fun encode(pcm: ShortArray, n: Int, out: ByteArray): Int

  /** Emit what the encoder is still holding; returns the bytes written. */
  fun flush(out: ByteArray): Int
}

/**
 * The part of the MP3 export that is decisions rather than codec: whether there is a recording to
 * export, and a loop that feeds an encoder in bounded chunks so a three-hour meeting never sits in
 * memory (3 h of PCM16 is ~345 MB). Pure Kotlin so a JVM test holds every rule.
 *
 * The source is `audio.pcm`: headerless 16 kHz mono PCM16, which is what a recording AND an import
 * both leave behind (see PlayerModule).
 */
object Mp3Export {
  /** The rejection code when the recording is gone. */
  const val AUDIO_DELETED = "AUDIO_DELETED"

  /** Shown to the person verbatim. Never fail silently. */
  const val DELETED_MESSAGE = "The recording for this meeting was deleted, so there is nothing to export."

  /** 64 KiB per read: 2 seconds of audio, 32768 samples. */
  const val CHUNK_BYTES = 64 * 1024

  enum class AudioState { OK, DELETED }

  enum class Outcome { DONE, CANCELLED }

  /**
   * Whether there is audio to export. BOTH signals, because each is wrong alone: the
   * `audio_retained` column is only ever written to 0 and says nothing about a restore, and a file
   * can vanish without the column changing (see PlayerModule.hasAudio).
   */
  fun audioState(retained: Boolean, file: File?): AudioState {
    if (!retained) return AudioState.DELETED
    // length() of a file that does not exist is 0, so this one test covers "missing" and "empty".
    if (file == null || file.length() == 0L) return AudioState.DELETED
    return AudioState.OK
  }

  /**
   * Feed [input] to [enc] a chunk at a time, writing MP3 to [out]. [cancelled] is asked before every
   * chunk; on cancel the encoder is NOT flushed and the caller deletes the partial file.
   * [onProgress] gets 0..1 and the last call is exactly 1.0.
   */
  fun encode(
    input: InputStream,
    totalBytes: Long,
    enc: Mp3Encoder,
    out: OutputStream,
    cancelled: () -> Boolean,
    onProgress: (Double) -> Unit,
  ): Outcome {
    val bytes = ByteArray(CHUNK_BYTES)
    val samples = ShortArray(CHUNK_BYTES / 2)
    // LAME's documented worst case for n samples is 1.25 n + 7200 bytes.
    val mp3 = ByteArray(samples.size * 5 / 4 + 7200)
    var done = 0L
    while (true) {
      if (cancelled()) return Outcome.CANCELLED
      val got = readFully(input, bytes)
      if (got <= 0) break
      val n = got / 2 // an odd trailing byte is half a sample: dropped, not encoded
      for (i in 0 until n) {
        samples[i] = ((bytes[2 * i].toInt() and 0xFF) or (bytes[2 * i + 1].toInt() shl 8)).toShort()
      }
      val w = enc.encode(samples, n, mp3)
      check(w >= 0) { "encoder failed ($w)" }
      out.write(mp3, 0, w)
      done += got
      if (totalBytes > 0) onProgress(minOf(0.99, done.toDouble() / totalBytes))
    }
    val w = enc.flush(mp3)
    check(w >= 0) { "encoder flush failed ($w)" }
    out.write(mp3, 0, w)
    onProgress(1.0)
    return Outcome.DONE
  }

  private fun readFully(input: InputStream, buf: ByteArray): Int {
    var off = 0
    while (off < buf.size) {
      val n = input.read(buf, off, buf.size - off)
      if (n < 0) break
      off += n
    }
    return off
  }

  /** A filename that is safe in a cache directory and never empty. */
  fun safeName(title: String): String =
    title.replace(Regex("[^A-Za-z0-9-_ ]"), "").trim().ifEmpty { "meeting" }

  /**
   * Delete everything in the export cache. The share sheet is asynchronous, so a file cannot be
   * removed the moment it is handed over; it is removed at the next app start and before the next
   * export instead, when nothing can be reading it.
   */
  fun sweep(dir: File) {
    dir.listFiles()?.forEach { it.delete() }
  }
}
