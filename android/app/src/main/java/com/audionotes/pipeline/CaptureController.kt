package com.audionotes.pipeline

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.audionotes.data.AudioDb
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Shared capture state + control, used by BOTH the RN module (AudioPipelineModule) and the floating
 * overlay (OverlayService) so recording behaves identically no matter how it was started. Keeps a
 * single source of truth for "are we recording, which meeting, since when".
 */
object CaptureController {
  private const val TAG = "CaptureController"

  @Volatile var currentMeetingId: String? = null
    private set
  @Volatile var startedAtMs: Long = 0L
    private set

  /** Counted down by RecordingService.onDestroy so stop() can wait for the flush. */
  @Volatile private var stopLatch: CountDownLatch? = null

  /** Live input level 0..1, updated by RecordingService each buffer; read by the UI meter. */
  @Volatile var level: Float = 0f

  /**
   * True while the system has muted our capture (phone call, privacy toggle, or another app
   * holding the mic). The recording is still running and the file still grows — with silence —
   * so the UI has to say so or the user only finds out when the transcript comes back empty.
   */
  @Volatile var silenced: Boolean = false

  /**
   * Paused means "keep the session and the file open, but stop appending audio".
   *
   * The AudioRecord itself keeps running and its buffers keep being drained — stopping it would
   * risk not getting the mic back if something else grabs it mid-meeting, and would drop the
   * foreground-service mic attribution. We simply discard what we read while paused.
   */
  @Volatile var paused: Boolean = false

  /** Total time spent paused, so the timer reports captured audio rather than wall clock. */
  @Volatile var pausedTotalMs: Long = 0L
  @Volatile private var pausedAtMs: Long = 0L

  // Named applyPause, not setPaused: `var paused` already generates a JVM setPaused(Z)V, and a
  // second method with that signature is a platform declaration clash.
  fun applyPause(value: Boolean) {
    if (!isRecording || value == paused) return
    if (value) {
      pausedAtMs = System.currentTimeMillis()
    } else if (pausedAtMs > 0L) {
      pausedTotalMs += System.currentTimeMillis() - pausedAtMs
      pausedAtMs = 0L
    }
    paused = value
  }

  val isRecording: Boolean get() = currentMeetingId != null

  /**
   * Elapsed CAPTURED time, excluding any paused stretches — this must match the length of the
   * audio on disk, or the timer would claim a 10-minute meeting for a 4-minute recording.
   */
  fun elapsedMs(): Long {
    if (!isRecording) return 0L
    val livePause = if (paused && pausedAtMs > 0L) System.currentTimeMillis() - pausedAtMs else 0L
    return System.currentTimeMillis() - startedAtMs - pausedTotalMs - livePause
  }

  fun hasMicPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED

  /** Create the meeting row, start the foreground capture service. Returns the meetingId, or null. */
  fun start(context: Context, tier: String = "free"): String? {
    if (isRecording) return currentMeetingId
    if (!hasMicPermission(context)) return null

    val meetingId = UUID.randomUUID().toString()
    val createdAt = System.currentTimeMillis()
    val dir = File(context.filesDir, "meetings/$meetingId").apply { mkdirs() }
    val audioPath = File(dir, "audio.pcm").absolutePath

    AudioDb.get(context).insertMeeting(meetingId, defaultTitle(createdAt), createdAt, tier, audioPath)

    val intent = Intent(context, RecordingService::class.java).apply {
      putExtra(RecordingService.EXTRA_MEETING_ID, meetingId)
      putExtra(RecordingService.EXTRA_AUDIO_PATH, audioPath)
    }
    ContextCompat.startForegroundService(context, intent)

    currentMeetingId = meetingId
    startedAtMs = createdAt
    // A previous session's pause bookkeeping would otherwise be subtracted from this one's timer.
    paused = false
    pausedTotalMs = 0L
    pausedAtMs = 0L
    return meetingId
  }

  /**
   * Stop capture and BLOCK until the service has flushed the PCM file and marked the meeting
   * 'captured'. Returns its id.
   *
   * The wait matters: stopService() is asynchronous, so without it process() would start VAD
   * while the capture thread was still writing the tail of the file (and, before audio_path
   * moved to insertMeeting, would fail outright with "no audio"). Bounded so a wedged service
   * degrades to a late-but-correct read rather than hanging the caller forever. Call off the
   * main thread.
   */
  fun stop(context: Context): String? {
    val id = currentMeetingId ?: return null
    val latch = CountDownLatch(1)
    stopLatch = latch
    context.stopService(Intent(context, RecordingService::class.java))
    currentMeetingId = null
    startedAtMs = 0L
    try {
      if (!latch.await(5, TimeUnit.SECONDS)) {
        Log.w(TAG, "timed out waiting for RecordingService to finish; audio may be short")
      }
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    } finally {
      stopLatch = null
    }
    return id
  }

  /** Called by RecordingService.onDestroy once the PCM is flushed and the row is updated. */
  fun onCaptureFinished() {
    stopLatch?.countDown()
  }

  /**
   * A meeting's starting title: "Morning meeting · Mon 3 Aug, 14:05".
   *
   * Every row used to be the literal string "Meeting", which made the Library a wall of identical
   * entries with nothing to tell them apart. The time of day is the cheapest thing that actually
   * distinguishes them; once a transcript exists the pipeline replaces this with the first line of
   * what was said (see PipelineController.buildMinutes).
   */
  fun defaultTitle(createdAt: Long): String {
    val cal = java.util.Calendar.getInstance().apply { timeInMillis = createdAt }
    val part = when (cal.get(java.util.Calendar.HOUR_OF_DAY)) {
      in 5..11 -> "Morning"
      in 12..16 -> "Afternoon"
      in 17..20 -> "Evening"
      else -> "Late"
    }
    val stamp = java.text.SimpleDateFormat("EEE d MMM, HH:mm", java.util.Locale.getDefault())
      .format(java.util.Date(createdAt))
    return "$part meeting · $stamp"
  }
}
