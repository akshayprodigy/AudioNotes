package com.audionotes.pipeline

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.audionotes.data.AudioDb
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import kotlin.concurrent.thread

/**
 * Foreground service that owns audio capture and shows the persistent recording indicator
 * (also the consent signal). Captures 16 kHz mono PCM16 and streams it straight to disk in
 * chunks — a whole meeting is never held in RAM. On stop it marks the meeting 'captured'
 * with its real duration.
 */
class RecordingService : Service() {

  companion object {
    const val EXTRA_MEETING_ID = "meetingId"
    const val EXTRA_AUDIO_PATH = "audioPath"
    const val SAMPLE_RATE = 16000
    const val BYTES_PER_MS = 32 // 16000 samples/s * 2 bytes / 1000 ms
    private const val CHANNEL_ID = "audionotes.recording"
    private const val NOTIF_ID = 42
    private const val TAG = "RecordingService"
  }

  @Volatile private var recording = false
  private var worker: Thread? = null
  private var meetingId: String? = null
  private var audioPath: String? = null
  private var wakeLock: android.os.PowerManager.WakeLock? = null

  override fun onCreate() {
    super.onCreate()
    createChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    meetingId = intent?.getStringExtra(EXTRA_MEETING_ID)
    audioPath = intent?.getStringExtra(EXTRA_AUDIO_PATH)
    startInForeground()
    acquireWakeLock()
    if (audioPath != null && !recording) startCapture(audioPath!!)
    return START_STICKY
  }

  // Keep the CPU running so capture continues with the screen off / device idle. The foreground
  // service + mic type keep us alive; the wake lock guarantees the capture thread isn't frozen.
  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val pm = getSystemService(POWER_SERVICE) as android.os.PowerManager
    wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "audionotes:capture").apply {
      setReferenceCounted(false)
      acquire(6 * 60 * 60 * 1000L) // safety cap: 6h
    }
  }

  private fun startCapture(path: String) {
    val minBuf = AudioRecord.getMinBufferSize(
      SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    val bufferSize = maxOf(minBuf, SAMPLE_RATE) // ~0.5s headroom
    val source =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) MediaRecorder.AudioSource.UNPROCESSED
      else MediaRecorder.AudioSource.VOICE_RECOGNITION

    val record = try {
      @Suppress("MissingPermission")
      AudioRecord(source, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize)
    } catch (e: Exception) {
      Log.e(TAG, "AudioRecord init failed", e)
      stopSelf()
      return
    }
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      Log.e(TAG, "AudioRecord not initialized (permission?)")
      record.release()
      stopSelf()
      return
    }

    recording = true
    worker = thread(name = "audionotes-capture") {
      val buf = ByteArray(4096)
      BufferedOutputStream(FileOutputStream(File(path)), 1 shl 16).use { out ->
        record.startRecording()
        try {
          while (recording) {
            val n = record.read(buf, 0, buf.size)
            if (n > 0) {
              out.write(buf, 0, n)
              CaptureController.level = computeLevel(buf, n, CaptureController.level)
            }
          }
        } catch (e: Exception) {
          Log.e(TAG, "capture loop error", e)
        } finally {
          try { record.stop() } catch (_: Exception) {}
          record.release()
          out.flush()
        }
      }
    }
  }

  // RMS of a PCM16 buffer → 0..1, with a gain and a fast-attack / slow-decay smoothing so the
  // UI meter looks lively and responsive to speech.
  private fun computeLevel(buf: ByteArray, n: Int, prev: Float): Float {
    var sum = 0.0
    var count = 0
    var i = 0
    while (i + 1 < n) {
      val s = (buf[i].toInt() and 0xff) or (buf[i + 1].toInt() shl 8)
      sum += (s.toShort().toInt() * s.toShort().toInt()).toDouble()
      count++
      i += 2
    }
    if (count == 0) return prev * 0.85f
    val rms = Math.sqrt(sum / count) / 32768.0
    val target = Math.min(1.0, rms * 3.5).toFloat() // gain so normal speech fills the meter
    return if (target > prev) target else prev * 0.8f + target * 0.2f // fast up, slow down
  }

  override fun onDestroy() {
    recording = false
    worker?.join(2000)
    worker = null
    CaptureController.level = 0f
    try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) {}
    wakeLock = null
    // Mark captured with real duration derived from the PCM byte count.
    val id = meetingId
    val path = audioPath
    if (id != null && path != null) {
      val bytes = File(path).length()
      val durationMs = bytes / BYTES_PER_MS
      try {
        AudioDb.get(applicationContext).markCaptured(id, durationMs, path)
      } catch (e: Exception) {
        Log.e(TAG, "markCaptured failed", e)
      }
    }
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun startInForeground() {
    val notif = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else {
      startForeground(NOTIF_ID, notif)
    }
  }

  private fun createChannel() {
    val mgr = getSystemService(NotificationManager::class.java)
    val channel = NotificationChannel(CHANNEL_ID, "Recording", NotificationManager.IMPORTANCE_LOW)
    channel.description = "Shown while AudioNotes is recording a meeting"
    mgr.createNotificationChannel(channel)
  }

  private fun buildNotification(): Notification =
    Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("AudioNotes")
      .setContentText("Recording — everything stays on this device")
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setOngoing(true)
      .build()
}
