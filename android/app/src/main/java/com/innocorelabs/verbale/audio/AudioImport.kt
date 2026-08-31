package com.innocorelabs.verbale.audio

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.pipeline.CaptureController
import com.innocorelabs.verbale.pipeline.RecordingService
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Turn a file somebody else made into a meeting.
 *
 * A WhatsApp voice note, a lecture, an interview recorded on something else — the pipeline needs
 * only one thing they do not already have, which is to be 16 kHz mono PCM16 on disk. Everything
 * downstream is then identical to a recording this app made itself: the same VAD, the same
 * whisper, the same minutes, the same player arithmetic.
 *
 * MediaExtractor and MediaCodec do the container and codec work, which is the part that has to
 * handle m4a/AAC, mp3, ogg/opus, amr, wav and whatever else a phone produces. What comes out is
 * PCM at the file's own rate and channel count; [Resampler] and the downmix here bridge the rest.
 */
object AudioImport {
  private const val TAG = "AudioImport"

  /** Mirrors RecordingService: below this we refuse rather than fill the disk. */
  private const val MIN_FREE_BYTES = 50L * 1024 * 1024

  /**
   * Four hours, which is longer than any meeting and about 460 MB of PCM.
   *
   * A cap exists because this accepts a file from ANOTHER app: nothing stops somebody sharing an
   * audiobook, and the failure mode without a limit is a full disk and an hour of wasted battery
   * before anyone finds out.
   */
  private const val MAX_DURATION_MS = 4L * 60L * 60L * 1000L

  private const val TIMEOUT_US = 10_000L

  class ImportError(message: String) : Exception(message)

  /** done/total are milliseconds of source audio, so a caller can show real progress. */
  fun interface Progress {
    fun onProgress(doneMs: Long, totalMs: Long)
  }

  /**
   * Decode [uri] into a new meeting and return its id.
   *
   * Nothing is written to the database until the decode has finished. An import that dies half way
   * — the process killed, the file truncated — leaves a temp file and no meeting, rather than a
   * row stuck in 'recording' that the orphan sweep would later promote and transcribe as if the
   * truncated audio were the whole conversation.
   */
  fun import(ctx: Context, uri: Uri, progress: Progress? = null): String {
    if (ctx.filesDir.usableSpace < MIN_FREE_BYTES) {
      throw ImportError("Not enough free space to import this file")
    }

    val staging = File(ctx.filesDir, "imports").apply { mkdirs() }
    val temp = File(staging, "${UUID.randomUUID()}.pcm")
    val bytes: Long
    try {
      bytes = decodeTo(ctx, uri, temp, progress)
    } catch (e: Throwable) {
      temp.delete()
      throw e
    }

    if (bytes < RecordingService.BYTES_PER_MS * 250L) {
      temp.delete()
      throw ImportError("That file has almost no audio in it")
    }

    val meetingId = UUID.randomUUID().toString()
    val createdAt = System.currentTimeMillis()
    val dir = File(ctx.filesDir, "meetings/$meetingId").apply { mkdirs() }
    val audio = File(dir, "audio.pcm")
    if (!temp.renameTo(audio)) {
      // Different filesystem, or a stale target. Copy rather than fail the whole import.
      temp.inputStream().use { input -> audio.outputStream().use { input.copyTo(it) } }
      temp.delete()
    }

    val db = AudioDb.get(ctx)
    // The placeholder title on purpose, not the file name: shared audio arrives called
    // "AUD-20260831-WA0002", and the pipeline's auto-retitle will name this from what was actually
    // said — which is the whole reason that retitle exists. A name the user chooses beats both,
    // and renaming is one tap away.
    db.insertMeeting(meetingId, CaptureController.defaultTitle(createdAt), createdAt, "free", audio.absolutePath)
    db.markCaptured(meetingId, bytes / RecordingService.BYTES_PER_MS, audio.absolutePath)
    Log.i(TAG, "imported $meetingId (${bytes / 1024}KB of 16 kHz mono)")
    return meetingId
  }

  /** The file's own name, for telling the user what is being worked on. */
  fun displayName(ctx: Context, uri: Uri): String? =
    try {
      ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    } catch (_: Throwable) {
      null
    }

  private fun decodeTo(ctx: Context, uri: Uri, out: File, progress: Progress?): Long {
    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(ctx, uri, null)
    } catch (e: Throwable) {
      extractor.release()
      throw ImportError("That file could not be opened")
    }

    var track = -1
    var format: MediaFormat? = null
    for (i in 0 until extractor.trackCount) {
      val f = extractor.getTrackFormat(i)
      if (f.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true) {
        track = i
        format = f
        break
      }
    }
    if (track < 0 || format == null) {
      extractor.release()
      throw ImportError("There is no audio in that file")
    }

    val totalMs = if (format.containsKey(MediaFormat.KEY_DURATION)) {
      format.getLong(MediaFormat.KEY_DURATION) / 1000L
    } else {
      0L
    }
    if (totalMs > MAX_DURATION_MS) {
      extractor.release()
      throw ImportError("That recording is longer than four hours")
    }

    extractor.selectTrack(track)
    val mime = format.getString(MediaFormat.KEY_MIME)!!
    val codec = try {
      MediaCodec.createDecoderByType(mime)
    } catch (e: Throwable) {
      extractor.release()
      throw ImportError("This phone cannot decode $mime")
    }

    var written = 0L
    try {
      codec.configure(format, null, null, 0)
      codec.start()

      // Read from the OUTPUT format rather than the input's: a decoder is entitled to hand back a
      // different rate or channel count than the container advertised, and it announces that with
      // INFO_OUTPUT_FORMAT_CHANGED before the first buffer.
      var inRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      var pcmFloat = false
      var resampler = Resampler(inRate, RecordingService.SAMPLE_RATE)

      val info = MediaCodec.BufferInfo()
      var sawInputEnd = false
      var sawOutputEnd = false
      var mono = FloatArray(0)

      BufferedOutputStream(FileOutputStream(out), 1 shl 16).use { sink ->
        while (!sawOutputEnd) {
          if (!sawInputEnd) {
            val inIndex = codec.dequeueInputBuffer(TIMEOUT_US)
            if (inIndex >= 0) {
              val buf = codec.getInputBuffer(inIndex)!!
              val size = extractor.readSampleData(buf, 0)
              if (size < 0) {
                codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                sawInputEnd = true
              } else {
                codec.queueInputBuffer(inIndex, 0, size, extractor.sampleTime, 0)
                extractor.advance()
              }
            }
          }

          when (val outIndex = codec.dequeueOutputBuffer(info, TIMEOUT_US)) {
            MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
              val f = codec.outputFormat
              inRate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE)
              channels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
              pcmFloat = f.containsKey(MediaFormat.KEY_PCM_ENCODING) &&
                f.getInteger(MediaFormat.KEY_PCM_ENCODING) == 4 // AudioFormat.ENCODING_PCM_FLOAT
              resampler = Resampler(inRate, RecordingService.SAMPLE_RATE)
            }
            MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
            else -> {
              if (outIndex >= 0) {
                if (info.size > 0) {
                  val buf = codec.getOutputBuffer(outIndex)!!
                  buf.position(info.offset)
                  buf.limit(info.offset + info.size)
                  val frames = downmix(buf, channels, pcmFloat, mono)
                  mono = frames.first
                  val n = frames.second
                  val resampled = resampler.process(mono, n, flush = false)
                  written += writePcm16(sink, resampled)
                }
                val end = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                codec.releaseOutputBuffer(outIndex, false)
                if (end) {
                  written += writePcm16(sink, resampler.process(FloatArray(0), 0, flush = true))
                  sawOutputEnd = true
                }
              }
            }
          }

          if (written > MAX_DURATION_MS * RecordingService.BYTES_PER_MS) {
            throw ImportError("That recording is longer than four hours")
          }
          progress?.onProgress(written / RecordingService.BYTES_PER_MS, totalMs)
        }
      }
    } finally {
      try { codec.stop() } catch (_: Throwable) {}
      codec.release()
      extractor.release()
    }
    return written
  }

  /**
   * Interleaved samples of whatever width, to one channel of float.
   *
   * Channels are AVERAGED rather than taking the left one. A phone recording a room puts two
   * different distances from the speaker into the two channels, and picking one throws away half
   * the signal-to-noise on the voice furthest from that mic.
   *
   * `scratch` is reused across buffers so a long file does not allocate a megabyte per callback.
   */
  private fun downmix(
    buf: ByteBuffer,
    channels: Int,
    pcmFloat: Boolean,
    scratch: FloatArray,
  ): Pair<FloatArray, Int> {
    val src = buf.order(ByteOrder.nativeOrder())
    val ch = max(1, channels)
    val samples = if (pcmFloat) src.remaining() / 4 else src.remaining() / 2
    val frames = samples / ch
    val outBuf = if (scratch.size >= frames) scratch else FloatArray(max(frames, 4096))

    if (pcmFloat) {
      val fb = src.asFloatBuffer()
      for (i in 0 until frames) {
        var sum = 0f
        for (c in 0 until ch) sum += fb.get(i * ch + c)
        outBuf[i] = sum / ch
      }
    } else {
      val sb = src.asShortBuffer()
      for (i in 0 until frames) {
        var sum = 0f
        for (c in 0 until ch) sum += sb.get(i * ch + c) / 32768f
        outBuf[i] = sum / ch
      }
    }
    return outBuf to frames
  }

  /** Float back to the PCM16 little-endian the rest of the app reads. Returns bytes written. */
  private fun writePcm16(sink: java.io.OutputStream, samples: FloatArray): Long {
    if (samples.isEmpty()) return 0L
    val bytes = ByteArray(samples.size * 2)
    for (i in samples.indices) {
      // Clamped, not wrapped. A resampler's ringing can overshoot a signal that was already at
      // full scale, and an Int16 that wraps turns that overshoot into a loud click.
      val v = (min(1f, max(-1f, samples[i])) * 32767f).roundToInt()
      bytes[i * 2] = (v and 0xFF).toByte()
      bytes[i * 2 + 1] = ((v shr 8) and 0xFF).toByte()
    }
    sink.write(bytes)
    return bytes.size.toLong()
  }
}
