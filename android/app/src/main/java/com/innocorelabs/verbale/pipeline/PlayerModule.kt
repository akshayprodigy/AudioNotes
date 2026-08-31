package com.innocorelabs.verbale.pipeline

import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.innocorelabs.verbale.data.AudioDb
import java.io.File
import java.io.RandomAccessFile
import kotlin.math.max
import kotlin.math.min

/**
 * Player — playing a meeting back, so the notes can be checked against what was said.
 *
 * Native for a structural reason rather than a performance one: recordings are a HEADERLESS
 * 16 kHz mono PCM16 stream (`audio.pcm`, written by RecordingService), which no media player will
 * open — there is no container to parse. An AudioTrack fed from a file offset handles it directly,
 * and seeking becomes arithmetic instead of a container index:
 *
 *     byteOffset = ms * 16000 * 2 / 1000 = ms * RecordingService.BYTES_PER_MS
 *
 * That exactness is what makes tap-a-transcript-turn-to-play work: utterance timestamps are
 * already anchored to the recording's own timeline (whisper_asr.cpp re-anchors each chunk with
 * `chunk.first + t0`), so a turn's startMs seeks to the moment it was said with nothing in
 * between. See src/native/NativePlayer.ts.
 *
 * One thread owns the AudioTrack. play/pause/seek/stop arrive on the JS thread and only ever set
 * flags; the feeder acts on them at the top of its loop. AudioTrack is not thread-safe, and
 * flush() in particular is only valid on a paused track — driving it from two threads is how you
 * get a track stuck in a state where write() blocks forever and the screen freezes on release.
 */
class PlayerModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "Player"

  private companion object {
    const val TAG = "Player"
    /** 16 kHz mono: one millisecond is 16 frames, one frame is 2 bytes. */
    const val FRAMES_PER_MS = RecordingService.SAMPLE_RATE / 1000
    /** ~64 ms per write at 16 kHz. Small enough that pause and seek feel immediate. */
    const val CHUNK_BYTES = 2048
    const val TICK_MS = 200L
    const val NO_SEEK = -1L
  }

  // ---- State, all touched from the JS thread and the feeder ------------------------------------

  private val lock = Any()
  private var track: AudioTrack? = null
  private var file: RandomAccessFile? = null
  private var feeder: Thread? = null

  private var totalBytes = 0L
  private var durationMs = 0L

  @Volatile private var alive = false
  @Volatile private var playing = false
  /** Set by seek(), consumed by the feeder. Bytes, not ms, so the conversion happens once. */
  @Volatile private var pendingSeekBytes = NO_SEEK
  /** Where the current AudioTrack playback head counts FROM. Reset on every flush. */
  @Volatile private var baseMs = 0L
  /** How far the feeder has read. The position REPORTED comes from the playback head, not this. */
  @Volatile private var readBytes = 0L

  private var focusRequest: AudioFocusRequest? = null

  // ---- The module surface ----------------------------------------------------------------------

  @ReactMethod
  fun hasAudio(meetingId: String, promise: Promise) {
    Thread {
      try {
        val path = AudioDb.get(ctx).getAudioPath(meetingId)
        // The file, not the `audio_retained` flag: that column is only ever written to 0, and
        // after a restore it arrives from the donor phone describing a path never on this device.
        promise.resolve(path != null && File(path).length() > 0L)
      } catch (e: Throwable) {
        promise.reject("player_has_audio", e)
      }
    }.start()
  }

  @ReactMethod
  fun open(meetingId: String, promise: Promise) {
    Thread {
      try {
        // Capture uses an UNPROCESSED audio source with no echo cancellation, so playing one
        // meeting through the speaker while another records writes the playback INTO the new
        // recording, and transcribes it. Refusing is the only honest answer.
        if (CaptureController.isRecording) {
          promise.reject("player_recording", "Playback is unavailable while a meeting is recording")
          return@Thread
        }

        val path = AudioDb.get(ctx).getAudioPath(meetingId)
        val f = path?.let { File(it) }
        if (f == null || !f.exists() || f.length() == 0L) {
          promise.reject("player_no_audio", "This meeting's audio is no longer on the device")
          return@Thread
        }

        releaseEverything()

        synchronized(lock) {
          totalBytes = f.length()
          durationMs = totalBytes / RecordingService.BYTES_PER_MS
          file = RandomAccessFile(f, "r")
          track = newTrack()
          readBytes = 0L
          baseMs = 0L
          playing = false
          pendingSeekBytes = NO_SEEK
          alive = true
          feeder = Thread { feed() }.also { it.name = "verbale-player"; it.start() }
        }

        promise.resolve(Arguments.createMap().apply { putDouble("durationMs", durationMs.toDouble()) })
      } catch (e: Throwable) {
        releaseEverything()
        promise.reject("player_open", e)
      }
    }.start()
  }

  @ReactMethod
  fun play(promise: Promise) {
    try {
      synchronized(lock) {
        if (track == null) throw IllegalStateException("nothing is open")
        // Replaying from the start is what a person means by pressing play at the end.
        if (readBytes >= totalBytes) pendingSeekBytes = 0L
      }
      if (!requestFocus()) throw IllegalStateException("another app is using the audio output")
      playing = true
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("player_play", e)
    }
  }

  @ReactMethod
  fun pause(promise: Promise) {
    playing = false
    abandonFocus()
    promise.resolve(null)
  }

  @ReactMethod
  fun seek(positionMs: Double, promise: Promise) {
    try {
      val ms = max(0L, min(positionMs.toLong(), durationMs))
      // Frame-aligned: an odd byte offset would put the stream half a sample out and play static.
      pendingSeekBytes = (ms * RecordingService.BYTES_PER_MS) and 1L.inv()
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("player_seek", e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    releaseEverything()
    promise.resolve(null)
  }

  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}

  /**
   * Release on teardown as well as on stop().
   *
   * Playback holds audio focus and an output stream. If the JS side is torn down without calling
   * stop() — a reload in development, the app being killed while the meeting screen is open — the
   * feeder would otherwise keep the device open and keep the user's meeting audible.
   */
  override fun invalidate() {
    releaseEverything()
    super.invalidate()
  }

  // ---- The feeder ------------------------------------------------------------------------------

  private fun newTrack(): AudioTrack {
    val minBuf = AudioTrack.getMinBufferSize(
      RecordingService.SAMPLE_RATE,
      AudioFormat.CHANNEL_OUT_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    val bufBytes = max(minBuf, CHUNK_BYTES * 4)
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    val format = AudioFormat.Builder()
      .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
      .setSampleRate(RecordingService.SAMPLE_RATE)
      .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
      .build()
    return AudioTrack.Builder()
      .setAudioAttributes(attrs)
      .setAudioFormat(format)
      .setBufferSizeInBytes(bufBytes)
      .setTransferMode(AudioTrack.MODE_STREAM)
      .build()
  }

  /**
   * Read the file into the track, and report where we are.
   *
   * The position sent to JS comes from the track's playback HEAD, not from how far this loop has
   * read: writes run up to a buffer ahead of what the speaker has actually produced, and a
   * transcript that highlighted the turn a quarter-second before it was spoken would look broken
   * in exactly the situation playback exists to serve — checking a word against the audio.
   */
  private fun feed() {
    val buf = ByteArray(CHUNK_BYTES)
    var lastTick = 0L
    var ended = false
    // Ticks are for a moving playhead. While paused nothing moves, so the stream stops rather
    // than sending the same position across the bridge five times a second at rest — but a
    // transition (pausing, seeking, reaching the end) still emits once, so the screen lands on the
    // right frame instead of on whatever it last heard.
    var wasPlaying = false

    while (alive) {
      try {
        val t = synchronized(lock) { track } ?: break
        val f = synchronized(lock) { file } ?: break

        // Seeks are applied here, on the thread that owns the track: flush() is only valid on a
        // track that is not playing, and it resets the playback head, which is what baseMs counts
        // from.
        val seekTo = pendingSeekBytes
        if (seekTo != NO_SEEK) {
          pendingSeekBytes = NO_SEEK
          t.pause()
          t.flush()
          readBytes = min(seekTo, totalBytes)
          baseMs = readBytes / RecordingService.BYTES_PER_MS
          f.seek(readBytes)
          ended = false
          lastTick = 0L
          emitTick(t) // the new position, now, rather than up to TICK_MS later
        }

        if (!playing) {
          if (t.playState == AudioTrack.PLAYSTATE_PLAYING) t.pause()
          if (wasPlaying) {
            wasPlaying = false
            emitTick(t)
          }
          Thread.sleep(30)
          continue
        }
        wasPlaying = true

        if (readBytes >= totalBytes) {
          if (!ended) {
            ended = true
            playing = false
            abandonFocus()
            emitTick(t)
            emit("onPlayerEnd", Arguments.createMap())
          }
          Thread.sleep(30)
          continue
        }

        if (t.playState != AudioTrack.PLAYSTATE_PLAYING) t.play()

        val want = min(CHUNK_BYTES.toLong(), totalBytes - readBytes).toInt()
        val got = f.read(buf, 0, want)
        if (got <= 0) {
          readBytes = totalBytes
          continue
        }
        // Blocking write. This is the loop's pacing: it returns as the speaker consumes audio,
        // which is why no timer is needed to play at the right speed.
        val wrote = t.write(buf, 0, got)
        if (wrote < 0) {
          Log.w(TAG, "AudioTrack.write failed ($wrote)")
          playing = false
          continue
        }
        readBytes += wrote
        // A short write means the track took less than offered; rewind the file to match so the
        // remainder is not silently skipped.
        if (wrote < got) f.seek(readBytes)

        emitTickIfDue(t, lastTick).let { if (it != 0L) lastTick = it }
      } catch (e: InterruptedException) {
        break
      } catch (e: Throwable) {
        Log.w(TAG, "playback stopped", e)
        playing = false
        break
      }
    }
  }

  /** Returns the new tick timestamp, or 0 when nothing was emitted. */
  private fun emitTickIfDue(t: AudioTrack, lastTick: Long): Long {
    val now = System.currentTimeMillis()
    if (now - lastTick < TICK_MS) return 0L
    emitTick(t)
    return now
  }

  private fun emitTick(t: AudioTrack) {
    // getPlaybackHeadPosition is in FRAMES and is reset by flush(), which is exactly when baseMs
    // is set — so the two always describe the same origin.
    val head = try { t.playbackHeadPosition.toLong() and 0xFFFFFFFFL } catch (_: Throwable) { 0L }
    val positionMs = min(durationMs, baseMs + head / FRAMES_PER_MS)
    emit(
      "onPlayerTick",
      Arguments.createMap().apply {
        putDouble("positionMs", positionMs.toDouble())
        putDouble("durationMs", durationMs.toDouble())
        putBoolean("playing", playing)
      },
    )
  }

  private fun emit(event: String, map: com.facebook.react.bridge.WritableMap) {
    try {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(event, map)
    } catch (_: Throwable) {
      // No JS context. Playback is a foreground-screen feature; there is nothing to tell.
    }
  }

  // ---- Teardown and audio focus ----------------------------------------------------------------

  private fun releaseEverything() {
    val t: Thread?
    synchronized(lock) {
      alive = false
      playing = false
      t = feeder
      feeder = null
    }
    // Joined before the track is released: the feeder can be inside a blocking write, and
    // releasing an AudioTrack under it is a native crash rather than an exception.
    t?.interrupt()
    try { t?.join(1000) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }

    synchronized(lock) {
      try { track?.pause(); track?.flush(); track?.release() } catch (_: Throwable) {}
      try { file?.close() } catch (_: Throwable) {}
      track = null
      file = null
      readBytes = 0L
      baseMs = 0L
      totalBytes = 0L
      durationMs = 0L
      pendingSeekBytes = NO_SEEK
    }
    abandonFocus()
  }

  /**
   * Take the audio output, and give it back the moment playback stops.
   *
   * Transient loss (a notification chime) is left alone — ducking a speech recording makes it
   * unintelligible, and the chime is over in a second. A real loss pauses: something else wants
   * the speaker, and continuing to play somebody's meeting over it is the wrong answer.
   */
  private fun requestFocus(): Boolean {
    val am = ctx.getSystemService(AudioManager::class.java) ?: return true
    val listener = AudioManager.OnAudioFocusChangeListener { change ->
      if (change == AudioManager.AUDIOFOCUS_LOSS) playing = false
    }
    val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        .setOnAudioFocusChangeListener(listener)
        .build()
      focusRequest = req
      am.requestAudioFocus(req)
    } else {
      @Suppress("DEPRECATION")
      am.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
    }
    return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  private fun abandonFocus() {
    val am = ctx.getSystemService(AudioManager::class.java) ?: return
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        focusRequest?.let { am.abandonAudioFocusRequest(it) }
        focusRequest = null
      } else {
        @Suppress("DEPRECATION")
        am.abandonAudioFocus(null)
      }
    } catch (_: Throwable) {}
  }
}
