package com.audionotes.pipeline

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.audionotes.data.AudioDb
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Shared capture state + control, used by BOTH the RN module (AudioPipelineModule) and the floating
 * overlay (OverlayService) so recording behaves identically no matter how it was started. Keeps a
 * single source of truth for "are we recording, which meeting, since when".
 *
 * Two things make this more than a bag of `@Volatile` fields.
 *
 * DURABILITY. RecordingService returns START_REDELIVER_INTENT, so after a process kill Android
 * restarts it with the original meeting id and capture genuinely resumes — but it used to restore
 * that id only into the *service*. This object stayed empty, so `isRecording` read false while the
 * microphone was live: the notification's Stop returned at its first line and did nothing, and a
 * fresh start would happily open a second session over the same PCM file. The snapshot in
 * [prefs] plus [adopt] closes that hole.
 *
 * PUSH. Surfaces outside React (notification, bubble, tile) can't poll cheaply, so state changes
 * fan out to [CaptureListener]s on the main thread instead.
 */
object CaptureController {
  private const val TAG = "CaptureController"
  private const val PREFS = "audionotes.capture"

  const val END_STOPPED = "stopped"
  const val END_MIC_LOST = "mic_lost"
  const val END_WRITE_FAILED = "write_failed"
  const val END_UNKNOWN = "unknown"

  private val main = Handler(Looper.getMainLooper())
  private val listeners = CopyOnWriteArraySet<CaptureListener>()

  /** Set once from any entry point so the snapshot can be written without a Context to hand. */
  @Volatile private var prefs: SharedPreferences? = null

  fun addListener(l: CaptureListener) { listeners.add(l) }
  fun removeListener(l: CaptureListener) { listeners.remove(l) }

  private fun fanOut(block: (CaptureListener) -> Unit) {
    if (listeners.isEmpty()) return
    main.post { for (l in listeners) try { block(l) } catch (e: Exception) {
      Log.w(TAG, "listener threw", e)
    } }
  }

  @Volatile var currentMeetingId: String? = null
    private set
  @Volatile var startedAtMs: Long = 0L
    private set

  /** Counted down by RecordingService.onDestroy so stop() can wait for the flush. */
  @Volatile private var stopLatch: CountDownLatch? = null

  /**
   * True from the moment stop() is requested until the service confirms the flush.
   *
   * `isRecording` goes false immediately on stop so nothing writes more audio, but the service can
   * take up to five seconds to finish. In that window a surface reading only `isRecording` shows
   * "idle" and treats a tap as "start a new meeting" — while onDestroy still holds the main thread.
   * Surfaces render a distinct stopping state instead and refuse input.
   */
  @Volatile var stopping: Boolean = false
    private set

  /**
   * The session being torn down, and its final captured length, held across the flush.
   *
   * `currentMeetingId` has to go null the instant stop() is called so the capture loop stops and
   * nothing starts a second session — but the terminal event still has to say WHICH meeting ended,
   * and the confirmation UI still has to show how long it was. Reading either after the fact gives
   * null and 0.
   */
  @Volatile var endingMeetingId: String? = null
    private set
  @Volatile var lastElapsedMs: Long = 0L
    private set

  /** Live input level 0..1, updated by RecordingService each buffer; read by the UI meter. */
  @Volatile var level: Float = 0f

  /**
   * True while the system has muted our capture (phone call, privacy toggle, or another app
   * holding the mic). The recording is still running and the file still grows — with silence —
   * so the UI has to say so or the user only finds out when the transcript comes back empty.
   */
  @Volatile var silenced: Boolean = false
    private set

  fun applySilenced(value: Boolean) {
    if (silenced == value) return
    silenced = value
    fanOut { it.onSilencedChanged(value) }
  }

  /**
   * Paused means "keep the session and the file open, but stop appending audio".
   *
   * The AudioRecord itself keeps running and its buffers keep being drained — stopping it would
   * risk not getting the mic back if something else grabs it mid-meeting, and would drop the
   * foreground-service mic attribution. We simply discard what we read while paused.
   */
  @Volatile var paused: Boolean = false
    private set

  /** Total time spent paused, so the timer reports captured audio rather than wall clock. */
  @Volatile var pausedTotalMs: Long = 0L
    private set
  @Volatile private var pausedAtMs: Long = 0L

  // Named applyPause, not setPaused: `var paused` already generates a JVM setPaused(Z)V, and a
  // second method with that signature is a platform declaration clash.
  //
  // Returns whether the state actually changed, so a caller acting on a notification button can
  // tell "already paused" from "no session" instead of assuming its request landed.
  fun applyPause(value: Boolean): Boolean {
    if (!isRecording || value == paused) return false
    if (value) {
      pausedAtMs = System.currentTimeMillis()
    } else if (pausedAtMs > 0L) {
      pausedTotalMs += System.currentTimeMillis() - pausedAtMs
      pausedAtMs = 0L
    }
    paused = value
    persist()
    fanOut { it.onPausedChanged(value) }
    return true
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

  // ---------------------------------------------------------------------------------------------
  // Durable state
  // ---------------------------------------------------------------------------------------------

  fun attach(context: Context) {
    if (prefs == null) {
      prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }
  }

  private fun persist() {
    val id = currentMeetingId ?: return
    prefs?.edit()
      ?.putString("meetingId", id)
      ?.putLong("startedAtMs", startedAtMs)
      ?.putLong("pausedTotalMs", pausedTotalMs)
      ?.putLong("pausedAtMs", pausedAtMs)
      ?.putBoolean("paused", paused)
      ?.apply()
  }

  private fun clearPersisted() {
    prefs?.edit()?.clear()?.apply()
  }

  /**
   * Rehydrate after a process restart, called by RecordingService BEFORE it goes foreground.
   *
   * Android hands the service its original intent back (START_REDELIVER_INTENT) but knows nothing
   * about this object, so without this the microphone runs while `isRecording` reads false. The
   * pause clock is restored too: a meeting paused when the process died must not silently start
   * counting the dead time as captured audio.
   *
   * Deliberately does NOT fan out onCaptureStarted — nothing "started", and a listener registering
   * after the fact reads the state directly.
   */
  fun adopt(context: Context, meetingId: String, startedAt: Long, audioPath: String? = null) {
    attach(context)
    if (currentMeetingId == meetingId) return
    val p = prefs
    val sameSession = p?.getString("meetingId", null) == meetingId
    currentMeetingId = meetingId
    startedAtMs = if (sameSession) p?.getLong("startedAtMs", startedAt) ?: startedAt else startedAt
    pausedTotalMs = if (sameSession) p?.getLong("pausedTotalMs", 0L) ?: 0L else 0L
    pausedAtMs = if (sameSession) p?.getLong("pausedAtMs", 0L) ?: 0L else 0L
    paused = if (sameSession) p?.getBoolean("paused", false) ?: false else false
    stopping = false

    // Reconcile the clock against what is actually on disk.
    //
    // Restoring startedAtMs alone counts the window in which the process was DEAD as recorded
    // audio: nothing was written during it, but wall clock kept running. A meeting killed by an
    // OEM battery manager and restarted 40 seconds later would show a timer 40 seconds longer
    // than the file, and then save a shorter duration than it had been claiming. The PCM byte
    // count is the ground truth — elapsedMs() promises to match the audio, so make it.
    if (sameSession && audioPath != null) {
      val capturedMs = try { File(audioPath).length() / 32L } catch (_: Exception) { 0L }
      if (capturedMs > 0L) {
        val wall = System.currentTimeMillis() - startedAtMs
        val gap = wall - capturedMs - pausedTotalMs
        if (gap > 1000L) {
          pausedTotalMs += gap
          Log.i(TAG, "reconciled $gap ms of dead time against ${capturedMs}ms of audio on disk")
        }
      }
    }

    Log.i(TAG, "adopted $meetingId (paused=$paused, pausedTotal=${pausedTotalMs}ms, restored=$sameSession)")
    persist()
  }

  /**
   * The single exit. Every path out of a capture ends here — user stop, mic lost, write failure,
   * service destroyed by the system — so state can never be left half-torn-down.
   *
   * The previous `onCaptureFinished()` only counted the latch down, which meant a recording that
   * died from mic loss left `currentMeetingId` set forever: `isRecording` stayed true, the UI kept
   * sweeping a timer, and the next start() returned the dead session's id instead of opening a new
   * one. Idempotent, because onDestroy can follow a stop() that already ran.
   */
  fun onCaptureEnded(reason: String = END_UNKNOWN) {
    // Either the live session (mic lost, service killed) or the one stop() is flushing.
    val id = currentMeetingId ?: endingMeetingId
    if (currentMeetingId != null) lastElapsedMs = elapsedMs()
    currentMeetingId = null
    endingMeetingId = null
    startedAtMs = 0L
    paused = false
    pausedTotalMs = 0L
    pausedAtMs = 0L
    level = 0f
    silenced = false
    stopping = false
    clearPersisted()
    stopLatch?.countDown()
    if (id != null) {
      Log.i(TAG, "capture ended for $id ($reason)")
      fanOut { it.onCaptureEnded(id, reason) }
    }
  }

  /** Create the meeting row, start the foreground capture service. Returns the meetingId, or null. */
  fun start(context: Context, tier: String = "free"): String? {
    if (isRecording) return currentMeetingId
    // A start that lands during the flush would open a second session over a file the old one is
    // still writing. The caller sees null and can say "finishing the last one" rather than
    // silently producing a corrupt meeting.
    if (stopping) return null
    if (!hasMicPermission(context)) return null
    attach(context)

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
    silenced = false
    stopping = false
    persist()
    fanOut { it.onCaptureStarted(meetingId) }
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
    // Marked BEFORE stopService so nothing can slip a new session into the gap, and so surfaces
    // render "finishing" rather than "idle" for the duration of the flush.
    stopping = true
    endingMeetingId = id
    lastElapsedMs = elapsedMs()
    // isRecording must go false immediately — the capture loop checks it — but the rest of the
    // teardown now belongs to onCaptureEnded, which the service calls once the file is closed.
    currentMeetingId = null
    startedAtMs = 0L
    context.stopService(Intent(context, RecordingService::class.java))
    try {
      if (!latch.await(5, TimeUnit.SECONDS)) {
        Log.w(TAG, "timed out waiting for RecordingService to finish; audio may be short")
        // Do not strand every future start behind a stopping flag because one teardown wedged.
        stopping = false
        clearPersisted()
      }
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    } finally {
      stopLatch = null
    }
    return id
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
