package com.innocorelabs.verbale.pipeline

/**
 * LAME on the phone: 16 kHz mono PCM16 in, 64 kbps constant-bitrate MP3 out, ID3v2 title and date.
 *
 * LAME is LGPL and lives in its own shared library (libmp3lame.so); `libverbale_mp3.so` is the thin
 * JNI shim over it. Loaded on first use, so the app never pays for them until somebody exports.
 * One instance per export; [close] in a finally.
 */
class LameEncoder(title: String, year: String, comment: String) : Mp3Encoder, AutoCloseable {
  private var handle: Long

  init {
    load()
    handle = nativeOpen(SAMPLE_RATE, KBPS, title, year, comment)
    check(handle != 0L) { "could not start the MP3 encoder" }
  }

  override fun encode(pcm: ShortArray, n: Int, out: ByteArray): Int = nativeEncode(handle, pcm, n, out)

  override fun flush(out: ByteArray): Int = nativeFlush(handle, out)

  override fun close() {
    if (handle != 0L) nativeClose(handle)
    handle = 0L
  }

  private external fun nativeOpen(sampleRate: Int, kbps: Int, title: String, year: String, comment: String): Long
  private external fun nativeEncode(h: Long, pcm: ShortArray, n: Int, out: ByteArray): Int
  private external fun nativeFlush(h: Long, out: ByteArray): Int
  private external fun nativeClose(h: Long)

  companion object {
    const val SAMPLE_RATE = RecordingService.SAMPLE_RATE
    const val KBPS = 64

    @Volatile private var loaded = false

    @Synchronized private fun load() {
      if (loaded) return
      // The library first, by name, so the shim's DT_NEEDED resolves to the copy in the APK.
      System.loadLibrary("mp3lame")
      System.loadLibrary("verbale_mp3")
      loaded = true
    }
  }
}
