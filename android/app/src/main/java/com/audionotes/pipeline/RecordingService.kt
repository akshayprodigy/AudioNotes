package com.audionotes.pipeline

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
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
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.audionotes.R
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
class RecordingService : Service(), CaptureListener {

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

    /** Sent by the notification's buttons. */
    const val ACTION_STOP = "com.audionotes.action.STOP_RECORDING"
    const val ACTION_PAUSE = "com.audionotes.action.PAUSE_RECORDING"
    const val ACTION_RESUME = "com.audionotes.action.RESUME_RECORDING"
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
  private var notifTicker: java.util.Timer? = null
  private var audioManager: AudioManager? = null
  private var recordingCallback: AudioManager.AudioRecordingCallback? = null
  private var deviceCallback: AudioDeviceCallback? = null

  override fun onCreate() {
    super.onCreate()
    createChannel()
    // The notification is the reason CaptureListener exists, and it was the one surface not
    // subscribed to it. Pause pressed anywhere but on the notification itself — the Record screen,
    // the floating bubble — changed the state without repainting the shade, so it went on saying
    // "recording", with a chronometer counting up, over audio the capture loop was discarding.
    // It self-healed on the next 60-second tick, which is a long time to be told the wrong thing
    // by the surface the app calls its consent signal.
    CaptureController.addListener(this)
  }

  override fun onPausedChanged(paused: Boolean) = refreshNotification()
  override fun onSilencedChanged(silenced: Boolean) = refreshNotification()

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // ---- Control actions ----
    //
    // These MUST be handled before the meeting/path guard below: a notification button carries an
    // action and no extras, so falling through would hit that guard and stopSelf() — the Pause
    // button would end the meeting.
    when (intent?.action) {
      ACTION_STOP -> {
        // Tear the service down here rather than relying on CaptureController.stop(), which
        // returns at its first line whenever currentMeetingId is null — exactly the state a
        // process restart used to leave behind, making this button permanently inert.
        Thread {
          CaptureController.stop(applicationContext)
          stopSelfSafely()
        }.start()
        return START_NOT_STICKY
      }
      ACTION_PAUSE, ACTION_RESUME -> {
        val want = intent.action == ACTION_PAUSE
        if (!CaptureController.applyPause(want)) {
          Log.w(TAG, "pause=$want ignored (recording=${CaptureController.isRecording}, already=${CaptureController.paused})")
        }
        refreshNotification()
        return START_STICKY
      }
    }

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
    // Rehydrate the shared state BEFORE the notification is built, or a service restarted by
    // START_REDELIVER_INTENT runs the microphone while CaptureController still reads "idle" —
    // which is what made Stop a no-op and let a second session open over this same file.
    CaptureController.adopt(applicationContext, id, System.currentTimeMillis(), path)
    startInForeground()
    acquireWakeLock()
    if (!recording) startCapture(path)
    startNotificationTicker()
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
                // While paused we keep READING (so the AudioRecord buffer never overruns and we
                // never risk losing the mic to another app mid-meeting) but discard the samples.
                // The level is driven to zero rather than frozen, so the meter visibly flatlines
                // instead of holding whatever it happened to show when pause was pressed.
                if (CaptureController.paused) {
                  CaptureController.level = 0f
                } else {
                  out.write(buf, 0, n)
                  CaptureController.level = computeLevel(buf, n, CaptureController.level)
                }
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
            CaptureController.applySilenced(nowSilenced)
            refreshNotification()
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
    CaptureController.applySilenced(false)
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
    if (rms <= 0.0) return prev * 0.8f

    // Map dBFS, not raw amplitude. Loudness is perceived logarithmically, and a linear `rms * k`
    // meter spends almost its whole range on sounds too loud to occur in a meeting: measured on
    // device, a clearly-audible voice in a normal room peaked at rms 0.008 (-42 dBFS), which the
    // old `rms * 3.5` rendered as 0.03 — below the visualiser's floor, so the bars sat flat and
    // the recorder looked broken while it was in fact transcribing that audio perfectly well.
    //
    // -55 dBFS maps to 0 and -10 dBFS to 1. Against the levels actually measured on this device
    // that puts room tone at ~0.07 (at the visualiser's floor, so it still reads as silence) and
    // speech across 0.30-0.90, which is the range where the meter has somewhere to move.
    val db = 20.0 * Math.log10(rms)
    val target = Math.max(0.0, Math.min(1.0, (db + 55.0) / 45.0)).toFloat()
    return if (target > prev) target else prev * 0.8f + target * 0.2f // fast up, slow down
  }

  override fun onDestroy() {
    // FIRST, before anything else can call back into us. Registering in onCreate without ever
    // unregistering leaked a dead Service per meeting: each one stayed subscribed to the shared
    // CaptureController and would still respond to a later pause by re-posting its notification —
    // an ongoing "Recording" belonging to a service that no longer exists, which nothing can
    // dismiss. Removing before teardown is also what makes the ordering safe, since fanOut
    // resolves the listener set at delivery time on the main thread.
    CaptureController.removeListener(this)
    foregrounded = false
    recording = false
    stopNotificationTicker()
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
    //
    // Unconditional, and carrying the reason. Previously this only counted the latch down, so a
    // capture that ended from mic loss or a full disk (paths that never go through stop()) left
    // CaptureController believing a meeting was still running: isRecording stayed true forever,
    // every surface kept sweeping a timer over a dead microphone, and the next start() returned
    // the corpse's id rather than opening a new session.
    CaptureController.onCaptureEnded(
      when (endReason) {
        END_MIC_LOST -> CaptureController.END_MIC_LOST
        END_DISK_FULL -> CaptureController.END_WRITE_FAILED
        else -> CaptureController.END_STOPPED
      },
    )
    super.onDestroy()
  }

  /**
   * The app was swiped out of Recents.
   *
   * Recording deliberately continues: setting the phone down and using other apps is the primary
   * way this product is used, and a swipe in Recents is how people tidy their task list, not how
   * they end a meeting. The notification remains as the control, and is re-posted immediately so
   * it cannot be left showing stale text after the task went away.
   *
   * `android:stopWithTask="false"` in the manifest is what makes this method the decision point
   * rather than a silent kill.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    if (CaptureController.isRecording) {
      Log.i(TAG, "task removed while recording — capture continues, notification is the control")
      refreshNotification()
    }
    super.onTaskRemoved(rootIntent)
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun startInForeground() {
    val notif = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else {
      startForeground(NOTIF_ID, notif)
    }
    foregrounded = true
  }

  /**
   * minSdk is 24, and NotificationChannel is API 26. Constructing it unguarded threw
   * NoClassDefFoundError on Android 7.x — the very first thing the service does, so the app could
   * not record at all there. NotificationChannelCompat is a no-op below 26 instead.
   */
  private fun createChannel() {
    val channel = NotificationChannelCompat.Builder(CHANNEL_ID, NotificationManagerCompat.IMPORTANCE_LOW)
      .setName(getString(R.string.notif_channel_recording))
      .setDescription(getString(R.string.notif_channel_recording_desc))
      .setShowBadge(false)
      .build()
    NotificationManagerCompat.from(this).createNotificationChannel(channel)
  }

  /**
   * Repost the notification — but only while this service is genuinely the live foreground
   * service.
   *
   * notify() with an id whose foreground notification has already been cancelled does not update
   * anything; it posts a NEW ongoing notification that nothing owns and no lifecycle will ever
   * remove. A listener callback arriving during teardown, or a stale PendingIntent fired after a
   * meeting ended, would strand a permanent "AudioNotes — recording" in the shade for a recording
   * that does not exist.
   */
  @Volatile private var foregrounded = false

  private fun refreshNotification() {
    if (!foregrounded) return
    try {
      NotificationManagerCompat.from(this).notify(NOTIF_ID, buildNotification())
    } catch (_: Exception) {
      // POST_NOTIFICATIONS denied. Capture is unaffected; only the control surface is missing.
    }
  }

  /**
   * stopSelf() from a worker thread after the flush has completed. Kept separate so the reason a
   * stop tears the service down is explicit rather than a side effect of stopService().
   */
  private fun stopSelfSafely() {
    foregrounded = false
    try {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } catch (_: Exception) {}
    stopSelf()
  }

  /** Refresh the elapsed time in the notification once a minute while recording. */
  private fun startNotificationTicker() {
    stopNotificationTicker()
    // Once a minute, not once a second: the notification only shows whole minutes, and waking
    // to redraw it every second during a two-hour meeting is a pointless battery cost.
    notifTicker = java.util.Timer("audionotes-notif", true).also {
      it.scheduleAtFixedRate(
        object : java.util.TimerTask() {
          override fun run() { if (recording) refreshNotification() }
        },
        60_000L, 60_000L,
      )
    }
  }

  private fun stopNotificationTicker() {
    notifTicker?.cancel()
    notifTicker = null
  }

  /** mm:ss, or h:mm past an hour. */
  private fun clockText(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return if (s < 3600) String.format("%d:%02d", s / 60, s % 60)
    else String.format("%dh%02d", s / 3600, (s % 3600) / 60)
  }

  private fun serviceIntent(action: String, requestCode: Int): PendingIntent =
    PendingIntent.getService(
      this, requestCode,
      Intent(this, RecordingService::class.java).apply { this.action = action },
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

  /**
   * The only control that exists when another app is in front and the bubble is off.
   *
   * It carries Pause/Resume as well as Stop — the app has had native pause since the capture
   * rework, and the surface most likely to need it was the one that never offered it.
   *
   * The elapsed time is a CHRONOMETER, counted by the system, not text we re-post. The old text
   * rounded to whole minutes and refreshed on a one-minute timer, so it read "less than a minute"
   * for the first 59 seconds of every meeting and could sit a minute stale after that. `when` is
   * anchored to the start of *captured* audio, so paused time never inflates it; while paused the
   * chronometer is switched off entirely rather than left running over audio nobody is recording.
   */
  private fun buildNotification(): Notification {
    val paused = CaptureController.paused
    val open = PendingIntent.getActivity(
      this, 0,
      Intent(this, com.audionotes.MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_IMMUTABLE,
    )

    val title = when {
      silenced -> getString(R.string.notif_title_silenced)
      paused -> getString(R.string.notif_title_paused)
      else -> getString(R.string.notif_title_recording)
    }
    val body = when {
      silenced -> getString(R.string.notif_body_silenced)
      paused -> getString(R.string.notif_body_paused)
      else -> getString(R.string.notif_body_recording)
    }

    val b = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(R.drawable.ic_notification_rec)
      .setOngoing(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setContentIntent(open)

    if (paused || !CaptureController.isRecording) {
      // No chronometer AND no timestamp. Leaving showWhen on renders `when` as a time of day, so
      // a meeting paused at 12:04 of captured audio displayed "5:53" — the wall clock — exactly
      // where the elapsed counter had been. The captured length moves into the body text instead,
      // where it cannot be mistaken for the time.
      b.setUsesChronometer(false)
      b.setShowWhen(false)
      b.setContentText(
        if (silenced) body
        else getString(R.string.notif_body_paused_at, clockText(CaptureController.elapsedMs())),
      )
    } else {
      // Wall-clock instant at which this meeting's CAPTURED time would have started had it never
      // been paused; the system counts up from there.
      b.setWhen(System.currentTimeMillis() - CaptureController.elapsedMs())
      b.setUsesChronometer(true)
      b.setShowWhen(true)
    }

    if (paused) {
      b.addAction(0, getString(R.string.notif_action_resume), serviceIntent(ACTION_RESUME, 2))
    } else {
      b.addAction(0, getString(R.string.notif_action_pause), serviceIntent(ACTION_PAUSE, 1))
    }
    b.addAction(0, getString(R.string.notif_action_stop), serviceIntent(ACTION_STOP, 3))

    applyPromotedOngoing(b, paused, silenced)

    val n = b.build()
    // Log whether the notification actually qualified. Asking for the promoted treatment does not
    // guarantee it: the system checks characteristics we can get wrong silently, and without this
    // the only symptom would be a chip that never appears, with nothing anywhere saying why.
    if (NotificationManagerCompat.from(this).canPostPromotedNotifications() &&
      !NotificationCompat.hasPromotableCharacteristics(n)
    ) {
      Log.w(TAG, "promoted ongoing requested but the notification does not qualify")
    }
    return n
  }

  /**
   * Android 16's "live update" treatment: a persistent chip in the status bar and a place on the
   * lock screen, the same affordance ride-hailing and timer apps use.
   *
   * This is the right shape for a recorder — the whole product is about setting the phone down and
   * forgetting it, and a chip showing the elapsed time is a standing answer to "is it still
   * going?" that costs no interaction at all.
   *
   * The chip text is MINUTE-granular on purpose. The notification is rebuilt once a minute, so
   * seconds in the chip would be visibly stale between ticks; showing "12m" is a number that is
   * still true when nobody has repainted it for fifty seconds. The expanded notification keeps the
   * live chronometer, which the system ticks itself.
   *
   * Guarded by canPostPromotedNotifications() rather than a version check: the user can turn the
   * treatment off per app, and the platform is the only thing that knows.
   */
  private fun applyPromotedOngoing(b: NotificationCompat.Builder, paused: Boolean, silenced: Boolean) {
    if (!NotificationManagerCompat.from(this).canPostPromotedNotifications()) return
    b.setRequestPromotedOngoing(true)
    b.setShortCriticalText(
      when {
        silenced -> getString(R.string.chip_no_mic)
        paused -> getString(R.string.chip_paused)
        else -> shortElapsed(CaptureController.elapsedMs())
      },
    )
  }

  /** "12m" / "1h07" — short enough for a status-bar chip, coarse enough to stay true for a minute. */
  private fun shortElapsed(ms: Long): String {
    val min = (ms / 60_000).coerceAtLeast(0)
    return if (min < 60) "${min}m" else String.format("%dh%02d", min / 60, min % 60)
  }
}
