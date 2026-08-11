package com.audionotes.pipeline

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.audionotes.data.AudioDb
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.util.UUID

/**
 * AudioPipeline — the single native seam the JS layer talks to. Audio and inference never cross
 * the JS bridge; only commands in and small results/events out.
 *
 * Milestone 1 implements: start/stop capture (via RecordingService + AudioDb) and process(),
 * which runs VAD in the C++ core and persists speech segments.
 */
class AudioPipelineModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  private var levelTimer: java.util.Timer? = null

  override fun getName() = "AudioPipeline"

  /**
   * Tell JS whenever capture state changes from OUTSIDE React.
   *
   * The Record screen re-read native state on mount and on app resume, which covers coming back to
   * a recording started elsewhere — but not the case where the screen is already open and the user
   * presses Stop on the notification or Pause on the bubble. The screen went on counting a meeting
   * that had ended, and its next sync reset the clock to 00:00 while the pill still read RECORDING.
   */
  private val captureListener = object : CaptureListener {
    override fun onCaptureStarted(meetingId: String) = emitState()
    override fun onCaptureEnded(meetingId: String, reason: String) = emitState()
    override fun onPausedChanged(paused: Boolean) = emitState()
    override fun onSilencedChanged(silenced: Boolean) = emitState()
  }

  private fun emitState() {
    val map = WritableNativeMap().apply {
      putBoolean("isRecording", CaptureController.isRecording)
      putString("meetingId", CaptureController.currentMeetingId)
      putBoolean("paused", CaptureController.paused)
      putBoolean("silenced", CaptureController.silenced)
      putDouble("elapsedMs", CaptureController.elapsedMs().toDouble())
    }
    try {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("onCaptureState", map)
    } catch (_: Exception) {
      // No JS context (the app is backgrounded or torn down). Native state remains the truth and
      // the screen re-reads it on resume.
    }
  }

  init {
    CaptureController.addListener(captureListener)
    // Lets the (foreground-service-hosted) ProcessingService reach JS with progress/completion
    // events while this module instance — and its ReactApplicationContext — is alive.
    AudioPipelineBridge.attach(ctx)
  }

  override fun invalidate() {
    CaptureController.removeListener(captureListener)
    stopLevelEmitter()
    super.invalidate()
  }

  // Push the live mic level to JS ~20x/s while recording, for the animated meter.
  private fun startLevelEmitter() {
    stopLevelEmitter()
    levelTimer = java.util.Timer("audionotes-level").also {
      it.scheduleAtFixedRate(object : java.util.TimerTask() {
        override fun run() {
          if (!CaptureController.isRecording) return
          val map = WritableNativeMap().apply { putDouble("level", CaptureController.level.toDouble()) }
          try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
              .emit("onCaptureLevel", map)
          } catch (_: Exception) {}
        }
      }, 0L, 50L)
    }
  }

  private fun stopLevelEmitter() {
    levelTimer?.cancel()
    levelTimer = null
  }

  @ReactMethod
  fun start(config: ReadableMap, promise: Promise) {
    if (!CaptureController.hasMicPermission(ctx)) {
      promise.reject("no_permission", "RECORD_AUDIO not granted")
      return
    }
    try {
      val tier = if (config.hasKey("tier")) config.getString("tier") ?: "free" else "free"
      val meetingId = CaptureController.start(ctx, tier)
        ?: throw IllegalStateException("could not start capture")
      startLevelEmitter()
      promise.resolve(meetingId) // sessionId == meetingId
    } catch (e: Exception) {
      promise.reject("start_failed", e)
    }
  }

  @ReactMethod
  fun stop(sessionId: String, promise: Promise) {
    // CaptureController.stop() blocks until RecordingService has flushed the PCM and marked the
    // meeting 'captured', so run it off the JS thread. Resolving only after that is what makes
    // the immediate process() call in RecordScreen safe.
    stopLevelEmitter()
    Thread {
      try {
        CaptureController.stop(ctx)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("stop_failed", e)
      }
    }.start()
  }

  /** Ask the OS to exempt us from battery optimization so long meetings aren't killed in the background. */
  @ReactMethod
  fun requestBatteryExemption(promise: Promise) {
    try {
      val pm = ctx.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
      if (pm.isIgnoringBatteryOptimizations(ctx.packageName)) {
        promise.resolve(true)
        return
      }
      val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = android.net.Uri.parse("package:" + ctx.packageName)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      ctx.startActivity(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("battery_exemption_failed", e)
    }
  }

  @ReactMethod
  fun process(meetingId: String, options: ReadableMap, promise: Promise) {
    // Processing now runs in ProcessingService (a foreground service) so it survives the app being
    // backgrounded/killed. This returns immediately; JS learns of completion via the onStageComplete
    // event (emitted by ProcessingService through AudioPipelineBridge), or discovers it on the next
    // pending-sweep if the app was killed. `options` currently only carries model=base (the sole
    // installed ASR model); the service uses base.
    try {
      ProcessingService.enqueue(ctx, meetingId)
      promise.resolve(null)
    } catch (e: Exception) {
      // Most likely ForegroundServiceStartNotAllowedException: enqueue() ran while the app was in the
      // background and the service wasn't already running (Android 12+ blocks starting a FGS from the
      // background). Reject so the JS awaiter settles instead of hanging the sweep forever; the meeting
      // stays pending and the next foreground sweep retries it.
      Log.w("AudioPipeline", "enqueue failed for $meetingId", e)
      promise.reject("enqueue_failed", e)
    }
  }

  /**
   * The live capture state, straight from CaptureController.
   *
   * Capture can be started by the floating bubble or survive the JS context being torn down, so
   * the JS store cannot assume it knows whether a recording is running — it has to ask on resume.
   * Without this, coming back into the app during a bubble-started meeting shows an idle Record
   * screen and tapping the mic starts a *second* meeting.
   */
  @ReactMethod
  fun currentSession(promise: Promise) {
    promise.resolve(
      WritableNativeMap().apply {
        putBoolean("isRecording", CaptureController.isRecording)
        putString("meetingId", CaptureController.currentMeetingId)
        putDouble("elapsedMs", CaptureController.elapsedMs().toDouble())
        putBoolean("silenced", CaptureController.silenced)
        putBoolean("paused", CaptureController.paused)
      },
    )
  }

  /**
   * Pause or resume capture without ending the meeting.
   *
   * Native owns this rather than JS holding a flag: capture survives the JS context being torn
   * down, so a paused state kept in JS would silently un-pause itself when the app came back and
   * quietly record a stretch the user believed was private.
   */
  @ReactMethod
  fun setPaused(paused: Boolean, promise: Promise) {
    CaptureController.applyPause(paused)
    promise.resolve(CaptureController.paused)
  }

  /**
   * Promote meetings stranded in 'recording' (process killed mid-capture) to 'captured' so the
   * normal pending-processing pass picks them up. Skips the live meeting if one is running.
   * Returns how many were recovered.
   */
  @ReactMethod
  fun recoverOrphans(promise: Promise) {
    Thread {
      try {
        val n = AudioDb.get(ctx).recoverOrphanedRecordings(CaptureController.currentMeetingId)
        if (n > 0) Log.i("AudioPipeline", "recovered $n meeting(s) stranded in 'recording'")
        promise.resolve(n)
      } catch (e: Exception) {
        promise.reject("recover_failed", e)
      }
    }.start()
  }

  /**
   * Cooperatively cancel a running pipeline.
   *
   * The native stages (VAD/ASR/diarize) are long single JNI calls that cannot be interrupted
   * part-way, so this marks the meeting cancelled and ProcessingEngine checks between stages. A
   * cancel therefore takes effect at the next stage boundary rather than instantly — which is the
   * right trade: killing a thread mid-inference would leak the model and could corrupt the
   * transcript write. The audio and any completed stages are kept, so Reprocess can resume later.
   */
  @ReactMethod
  fun cancel(meetingId: String) {
    Log.i("AudioPipeline", "cancel requested for $meetingId (applies at the next stage boundary)")
    ProcessingService.cancel(ctx, meetingId)
  }

  /**
   * Delete a meeting's raw audio once it has been transcribed.
   *
   * BUILD_PLAN 4.7 promises audio is either encrypted at rest or removed after transcription.
   * It was neither: raw 16 kHz PCM sat unencrypted in filesDir indefinitely (~115 MB/hour),
   * which is both the largest privacy exposure in the app and the main consumer of storage.
   * Deleting is the stronger guarantee and the cheaper one — the transcript is already in the
   * encrypted database, and the audio's only remaining use is Reprocess.
   *
   * Returns the number of bytes reclaimed.
   */
  @ReactMethod
  fun discardAudio(meetingId: String, promise: Promise) {
    Thread {
      try {
        val db = AudioDb.get(ctx)
        val path = db.getAudioPath(meetingId)
        var freed = 0L
        if (path != null) {
          val f = File(path)
          freed = f.length()
          if (f.exists() && !f.delete()) {
            Log.w("AudioPipeline", "could not delete audio for $meetingId")
            freed = 0L
          }
        }
        db.setAudioRetained(meetingId, false)
        Log.i("AudioPipeline", "discarded audio for $meetingId (${freed / 1024}KB)")
        promise.resolve(freed.toDouble())
      } catch (e: Exception) {
        promise.reject("discard_failed", e)
      }
    }.start()
  }

  /**
   * Hand JS the meetingId stashed by a cold-start "Notes ready" notification tap, exactly once.
   * MainActivity stores it in DeepLink.pendingMeetingId before React is ready (onCreate); the JS
   * navigator calls this on mount to deep-link to the meeting. Warm taps skip this and arrive as
   * the 'onOpenMeeting' device event instead. Resolves null when there is nothing pending.
   */
  @ReactMethod
  fun consumePendingMeetingId(promise: Promise) {
    val id = com.audionotes.DeepLink.pendingMeetingId
    com.audionotes.DeepLink.pendingMeetingId = null
    promise.resolve(id)
  }

  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}
}
