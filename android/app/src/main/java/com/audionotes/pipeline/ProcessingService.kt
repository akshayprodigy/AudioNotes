package com.audionotes.pipeline

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
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
  @Volatile private var worker: Thread? = null
  @Volatile private var current: ProcessingEngine? = null
  @Volatile private var currentId: String? = null
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val id = intent?.getStringExtra(EXTRA_MEETING_ID)
    if (id != null && id != currentId && !queue.contains(id)) queue.add(id)
    startForegroundSafe()
    ensureWorker()
    return START_REDELIVER_INTENT
  }

  private fun ensureWorker() {
    if (worker?.isAlive == true) return
    worker = Thread {
      try {
        acquireWakeLock()
        while (true) {
          val id = queue.poll() ?: break
          currentId = id
          updateNotification("Transcribing meeting…")
          val engine = ProcessingEngine(this, id, "base", object : ProcessingEngine.Listener {
            override fun onStage(stage: String, done: Int, total: Int) {
              updateNotification(stageLabel(stage))
              AudioPipelineBridge.emitProgress(id, stage, done, total)
            }
            override fun onComplete(outcome: String, message: String?) {
              AudioPipelineBridge.emitComplete(id, outcome, message)
            }
          })
          current = engine
          engine.run()
          current = null
          currentId = null
        }
      } finally {
        releaseWakeLock()
        stopForegroundCompat()
        stopSelf()
      }
    }.also { it.name = "audionotes-processing"; it.start() }
  }

  /** Cancel a queued or running meeting. */
  fun cancel(meetingId: String) {
    queue.remove(meetingId)
    if (currentId == meetingId) current?.cancelled = true
  }

  // --- foreground / notification (mirror RecordingService's idioms) ---
  private fun startForegroundSafe() {
    createChannel()
    val n = buildNotification("Transcribing meeting…")
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
    "vad" -> "Cleaning up audio…"; "asr" -> "Writing words down…"; "diarize" -> "Separating speakers…"; else -> "Transcribing meeting…"
  }

  companion object {
    private const val EXTRA_MEETING_ID = "meetingId"
    private const val NOTIF_ID = 43
    private const val CHANNEL_ID = "audionotes.processing"
    /** Start/queue processing for a meeting. MUST be called while the app is in the foreground
     *  (Android forbids starting a background FGS) — callers do so right after Stop / on app open. */
    fun enqueue(ctx: Context, meetingId: String) {
      val i = Intent(ctx, ProcessingService::class.java).putExtra(EXTRA_MEETING_ID, meetingId)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
    }
  }
}
