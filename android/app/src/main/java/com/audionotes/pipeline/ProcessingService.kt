package com.audionotes.pipeline

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.audionotes.R
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * Runs meeting processing (VAD/ASR/diarize via ProcessingEngine) in the background so it survives
 * the app being backgrounded or killed. One meeting at a time on a worker thread; a progress
 * notification keeps the process alive. Enqueue more ids by starting the service again with
 * EXTRA_MEETING_ID. Wired into the app in a later task via ProcessingService.enqueue(...).
 */
class ProcessingService : Service() {
  private val queue = ConcurrentLinkedQueue<String>()

  // Guards `running` and `currentId` together so an id enqueued while the worker is in its
  // finally-block teardown (releaseWakeLock -> stopForeground -> stopSelf, several IPCs) is never
  // stranded: onStartCommand's enqueue and the worker's decision to exit both happen under this
  // same lock, so one of two things is always true — either the id lands in the queue before the
  // worker checks it and is picked up, or `running` is still true when the id is added and the
  // caller does NOT start a second worker (the existing one is guaranteed to loop again).
  private val lock = Any()
  @Volatile private var running = false

  private var worker: Thread? = null
  @Volatile private var current: ProcessingEngine? = null
  @Volatile private var currentId: String? = null
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val id = intent?.getStringExtra(EXTRA_MEETING_ID)
    val shouldStart = synchronized(lock) {
      if (id != null && id != currentId && !queue.contains(id)) queue.add(id)
      if (!running) { running = true; true } else false
    }
    startForegroundSafe()
    if (shouldStart) worker = Thread { runLoop() }.also { it.name = "audionotes-processing"; it.start() }
    return START_REDELIVER_INTENT
  }

  private fun runLoop() {
    try {
      acquireWakeLock()
      while (true) {
        // The engine is constructed INSIDE the lock so that currentId and current are published
        // atomically together — a cancel() landing between "currentId is set" and "current is set"
        // would otherwise see currentId == meetingId but current == null and silently no-op,
        // losing the cancel. Construction itself is cheap (no IO), so holding the lock here is
        // fine; engine.run() — the actual VAD/ASR/diarize work — stays outside the lock.
        val engine = synchronized(lock) {
          val id = queue.poll()
          if (id == null) { running = false; return@synchronized null } // exit decided under the same lock as enqueue
          currentId = id
          ProcessingEngine(this, id, "base", object : ProcessingEngine.Listener {
            override fun onStage(stage: String, done: Int, total: Int) {
              try { updateNotification(stageLabel(stage)) } catch (_: Exception) {}
              AudioPipelineBridge.emitProgress(id, stage, done, total)
            }
            override fun onComplete(outcome: String, message: String?) {
              AudioPipelineBridge.emitComplete(id, outcome, message)
            }
          }).also { current = it }
        } ?: break
        try { updateNotification(LABEL_TRANSCRIBING) } catch (_: Exception) {
          // POST_NOTIFICATIONS denied or similar. Processing is unaffected; only the control
          // surface is missing — mirrors RecordingService.refreshNotification().
        }
        engine.run()
        synchronized(lock) { current = null; currentId = null }
      }
    } finally {
      releaseWakeLock()
      try { stopForegroundCompat() } catch (_: Exception) {}
      stopSelf()
    }
  }

  /**
   * Cancel a queued or running meeting.
   *
   * Running: mark the live engine cancelled; it emits the terminal "cancelled" event itself at the
   * next stage boundary. Queued-only: there is no engine to emit it, so this does — otherwise a
   * cancelled-while-queued meeting never produces a terminal event and, once JS awaits completion
   * events (Task 6), would hang forever.
   */
  fun cancel(meetingId: String) {
    val wasQueuedOnly = synchronized(lock) {
      val removed = queue.remove(meetingId)
      if (currentId == meetingId) { current?.cancelled = true; false } // running: engine emits "cancelled" itself
      else removed                                                     // queued-only: we must emit below
    }
    if (wasQueuedOnly) AudioPipelineBridge.emitComplete(meetingId, "cancelled", null) // emit OUTSIDE the lock
  }

  /**
   * The app was swiped out of Recents.
   *
   * Processing deliberately continues — that is the entire point of running it in a foreground
   * service rather than in-process: a swipe in Recents is how people tidy their task list, not how
   * they cancel a transcription. The notification remains as the only control surface.
   *
   * `android:stopWithTask="false"` in the manifest is what makes this method the decision point
   * rather than a silent kill (mirrors RecordingService.onTaskRemoved).
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    if (running) Log.i(TAG, "task removed while processing — work continues, notification is the control")
    super.onTaskRemoved(rootIntent)
  }

  /** Defensive: releases the wake lock if the service is torn down externally while the worker is
   *  mid-loop rather than mid-finally. releaseWakeLock() is idempotent (checks isHeld). */
  override fun onDestroy() {
    releaseWakeLock()
    if (instance === this) instance = null
    super.onDestroy()
  }

  // --- foreground / notification (mirror RecordingService's idioms) ---
  private fun startForegroundSafe() {
    createChannel()
    val n = buildNotification(LABEL_TRANSCRIBING)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
      startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    else startForeground(NOTIF_ID, n)
  }
  private fun updateNotification(text: String) =
    NotificationManagerCompat.from(this).notify(NOTIF_ID, buildNotification(text))
  private fun buildNotification(text: String): android.app.Notification =
    NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_notification_rec)
      .setContentTitle("AudioNotes")
      .setContentText(text)
      .setOngoing(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  private fun createChannel() = NotificationManagerCompat.from(this).createNotificationChannel(
    NotificationChannelCompat.Builder(CHANNEL_ID, NotificationManagerCompat.IMPORTANCE_LOW)
      .setName("Transcribing").build())
  private fun stopForegroundCompat() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
    else @Suppress("DEPRECATION") stopForeground(true)
  }
  private fun acquireWakeLock() {
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "audionotes:processing").apply { acquire(6 * 60 * 60 * 1000L) }
  }
  private fun releaseWakeLock() { wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null }
  private fun stageLabel(stage: String) = when (stage) {
    "vad" -> "Cleaning up audio…"; "asr" -> "Writing words down…"; "diarize" -> "Separating speakers…"; else -> LABEL_TRANSCRIBING
  }

  companion object {
    private const val EXTRA_MEETING_ID = "meetingId"
    private const val NOTIF_ID = 43
    private const val CHANNEL_ID = "audionotes.processing"
    private const val LABEL_TRANSCRIBING = "Transcribing meeting…"
    private const val TAG = "ProcessingService"
    /** The live instance, so cancel() below can reach it without a bind. Set in onCreate(),
     *  cleared in onDestroy() — a static registry rather than binding, since callers (the RN
     *  module) just need to fire a cancel, not hold a service connection. */
    @Volatile private var instance: ProcessingService? = null
    /** Start/queue processing for a meeting. MUST be called while the app is in the foreground
     *  (Android forbids starting a background FGS) — callers do so right after Stop / on app open. */
    fun enqueue(ctx: Context, meetingId: String) {
      val i = Intent(ctx, ProcessingService::class.java).putExtra(EXTRA_MEETING_ID, meetingId)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
    }
    /** Cancel a queued or running meeting inside the service, if it's alive. `ctx` is unused today
     *  but kept for symmetry with enqueue() and in case future callers need it (e.g. to start the
     *  service first). */
    fun cancel(ctx: Context, meetingId: String) {
      instance?.cancel(meetingId)
    }
  }
}
