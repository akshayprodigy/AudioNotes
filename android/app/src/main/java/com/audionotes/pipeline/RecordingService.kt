package com.audionotes.pipeline

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRecordingConfiguration
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

    /**
     * Stop capture rather than fill the device. Capture costs ~32 KB/s (~115 MB/hour), so this
     * is a couple of minutes of headroom — enough to close the file cleanly and keep everything
     * recorded so far, instead of the write silently truncating on a full disk.
     */
    private const val MIN_FREE_BYTES = 50L * 1024 * 1024

    /** How often the capture loop re-checks free space (in 4 KB reads; ~8 per second). */
    private const val DISK_CHECK_EVERY_READS = 256

    /** Why capture ended, surfaced on the meeting so the UI can explain a short recording. */
    const val END_NORMAL = "normal"
    const val END_DISK_FULL = "disk_full"
    const val END_MIC_LOST = "mic_lost"
  }

  @Volatile private var recording = false
  private var worker: Thread? = null
  private var meetingId: String? = null
  private var audioPath: String? = null
  private var wakeLock: android.os.PowerManager.WakeLock? = null

  @Volatile private var endReason: String = END_NORMAL
  /** True while the system has muted our capture (phone call, or another app took the mic). */
  @Volatile private var silenced = false

  private var audioRecord: AudioRecord? = null
  private var audioManager: AudioManager? = null
  private var recordingCallback: AudioManager.AudioRecordingCallback? = null
  private var deviceCallback: AudioDeviceCallback? = null

  override fun onCreate() {
    super.onCreate()
    createChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val id = intent?.getStringExtra(EXTRA_MEETING_ID)
    val path = intent?.getStringExtra(EXTRA_AUDIO_PATH)
    if (id == null || path == null) {
      // START_REDELIVER_INTENT should always hand the original intent back, so a null one means
      // we have nothing to capture into. Showing a "Recording" notification while writing nothing
      // is worse than not running at all — bail out instead of becoming a zombie service.
      Log.w(TAG, "onStartCommand with no meeting/audio path; stopping instead of running idle")
      stopSelf()
      return START_NOT_STICKY
    }
    meetingId = id
    audioPath = path
    startInForeground()
    acquireWakeLock()
    if (!recording) startCapture(path)
    // REDELIVER (not STICKY): if the process is killed, Android restarts us with THIS intent, so
    // meetingId/audioPath survive and capture actually resumes. With START_STICKY the intent comes
    // back null and the service would run without ever calling startCapture().
    return START_REDELIVER_INTENT
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
    // Refuse to start a meeting we cannot store. Failing loudly up front beats a recording that
    // quietly truncates ten minutes in.
    if (filesDir.usableSpace < MIN_FREE_BYTES) {
      Log.e(TAG, "refusing to start: only ${filesDir.usableSpace / 1024 / 1024}MB free")
      endReason = END_DISK_FULL
      stopSelf()
      return
    }

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
    audioRecord = record
    registerAudioWatchers(record)

    worker = thread(name = "audionotes-capture") {
      val buf = ByteArray(4096)
      // APPEND, not truncate: after a START_REDELIVER_INTENT restart the file already holds
      // everything captured before the kill. Opening without append would silently delete it.
      BufferedOutputStream(FileOutputStream(File(path), true), 1 shl 16).use { out ->
        record.startRecording()
        var reads = 0
        try {
          while (recording) {
            val n = record.read(buf, 0, buf.size)
            when {
              n > 0 -> {
                out.write(buf, 0, n)
                CaptureController.level = computeLevel(buf, n, CaptureController.level)
              }
              // A dead/invalid AudioRecord never recovers by itself: stop cleanly so the audio
              // captured so far is kept and processed, rather than spinning on an error.
              n == AudioRecord.ERROR_INVALID_OPERATION || n == AudioRecord.ERROR_DEAD_OBJECT -> {
                Log.e(TAG, "AudioRecord read failed ($n) — ending capture and keeping what we have")
                endReason = END_MIC_LOST
                recording = false
              }
            }

            if (++reads % DISK_CHECK_EVERY_READS == 0 && filesDir.usableSpace < MIN_FREE_BYTES) {
              Log.w(TAG, "free space below ${MIN_FREE_BYTES / 1024 / 1024}MB — stopping capture")
              endReason = END_DISK_FULL
              recording = false
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
      // Disk-full / mic-loss end the loop from inside; the service still has to tear itself down.
      if (endReason != END_NORMAL) stopSelf()
    }
  }

  /**
   * Watch the two things that silently ruin a long meeting:
   *
   *  - **Our capture being silenced.** A phone call, the privacy mic toggle, or another app
   *    taking the mic makes AudioRecord keep returning buffers — of pure silence. Without this
   *    the user gets a full-length recording that transcribes to nothing. `isClientSilenced`
   *    tells us the instant it happens, so we can mark the gap and say so in the notification.
   *  - **Route changes.** Plugging or unplugging a headset/Bluetooth mic swaps the input device
   *    mid-meeting; we log it and keep going (AudioRecord follows the new default route).
   *
   * Deliberately NOT using TelephonyManager call state: on API 31+ that needs READ_PHONE_STATE,
   * a sensitive permission we do not otherwise want, and silencing covers the same case.
   */
  private fun registerAudioWatchers(record: AudioRecord) {
    val am = getSystemService(AudioManager::class.java) ?: return
    audioManager = am

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val cb = object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>?) {
          val mine = configs?.firstOrNull { it.clientAudioSessionId == record.audioSessionId }
          val nowSilenced = mine?.isClientSilenced == true
          if (nowSilenced != silenced) {
            silenced = nowSilenced
            Log.w(TAG, if (nowSilenced) "capture SILENCED by the system (call or mic taken)" else "capture resumed")
            CaptureController.silenced = nowSilenced
            updateNotification()
          }
        }
      }
      recordingCallback = cb
      am.registerAudioRecordingCallback(cb, null)
    }

    val dc = object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) {
        if (added?.any { it.isSource } == true) Log.i(TAG, "input route added mid-capture")
      }
      override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) {
        if (removed?.any { it.isSource } == true) Log.i(TAG, "input route removed mid-capture")
      }
    }
    deviceCallback = dc
    am.registerAudioDeviceCallback(dc, null)
  }

  private fun unregisterAudioWatchers() {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        recordingCallback?.let { audioManager?.unregisterAudioRecordingCallback(it) }
      }
      deviceCallback?.let { audioManager?.unregisterAudioDeviceCallback(it) }
    } catch (_: Exception) {}
    recordingCallback = null
    deviceCallback = null
    audioManager = null
    audioRecord = null
    silenced = false
    CaptureController.silenced = false
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
    unregisterAudioWatchers()
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
      Log.i(TAG, "capture finished for $id: ${bytes}B (${durationMs}ms), reason=$endReason")
    }
    // Release CaptureController.stop() only now — the PCM is flushed and the row is updated,
    // so it is safe for the pipeline to read the file.
    CaptureController.onCaptureFinished()
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

  private fun updateNotification() {
    try {
      getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification())
    } catch (_: Exception) {}
  }

  private fun buildNotification(): Notification =
    Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("AudioNotes")
      .setContentText(
        if (silenced) "Paused — the mic is in use by another app"
        else "Recording — everything stays on this device",
      )
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setOngoing(true)
      .build()
}
