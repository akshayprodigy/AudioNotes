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

  /** Meetings for which cancel() was requested; checked at each pipeline stage boundary. */
  private val cancelled = java.util.Collections.synchronizedSet(mutableSetOf<String>())

  override fun getName() = "AudioPipeline"

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
    cancelled.remove(meetingId) // a fresh run is never pre-cancelled
    Thread {
      try {
        val db = AudioDb.get(ctx)
        val audioPath = db.getAudioPath(meetingId)
          ?: throw IllegalStateException("no audio for $meetingId")

        // Retention deletes the recording once it has been transcribed, so a re-run can arrive
        // with a path that no longer resolves. VAD over a missing file returns nothing, and the
        // old code committed that nothing — replaceSegments wiped the spans of a meeting that
        // still had a perfectly good transcript, leaving it reading "0 segments, 0s of speech".
        // With no audio there is nothing to re-derive, so leave the stored results alone and let
        // the caller rebuild the minutes from the transcript it already has.
        if (!java.io.File(audioPath).exists()) {
          Log.i("AudioPipeline", "re-run skipped for $meetingId (audio deleted by retention)")
          promise.resolve(null)
          return@Thread
        }
        val modelPath = ensureVadModel()

        // Per-stage wall times, logged against the audio length so the numbers are comparable
        // between recordings and against DiarEmbeddingBench. Without these the only timing signal
        // was the gap between two log lines, which attributes queueing and DB writes to whichever
        // stage happened to log next — enough to make a stage look 10x slower than it measures in
        // isolation.
        val audioMs = java.io.File(audioPath).length() / 32
        fun stageDone(stage: String, startedAt: Long) {
          val ms = System.currentTimeMillis() - startedAt
          val rt = if (audioMs > 0) ms.toDouble() / audioMs else 0.0
          Log.i("AudioPipeline", "stage=%s %dms (%.2fx realtime) audio=%ds %s"
            .format(stage, ms, rt, audioMs / 1000, meetingId))
        }

        emitProgress(meetingId, "vad", 0, 1)
        var t0 = System.currentTimeMillis()
        val segments = NativeBridge.nativeVad(audioPath, modelPath, RecordingService.SAMPLE_RATE)
        stageDone("vad", t0)
        db.replaceSegments(meetingId, segments)
        db.setStatus(meetingId, "vad")
        emitProgress(meetingId, "vad", 1, 1)
        Log.i("AudioPipeline", "VAD produced ${segments.size / 2} speech segments for $meetingId")
        if (checkCancelled(meetingId)) { promise.resolve(null); return@Thread }

        // ---- ASR (whisper.cpp) over the VAD spans, if the chosen model is installed ----
        val modelName = if (options.hasKey("model")) options.getString("model") ?: "base" else "base"
        val asrFile = com.audionotes.data.ModelCatalog.fileFor(ctx, com.audionotes.data.ModelCatalog.asrIdForModel(modelName))
        var transcribed = false
        if (segments.isNotEmpty() && asrFile != null && asrFile.exists()) {
          emitProgress(meetingId, "asr", 0, 1)
          val n = segments.size / 2
          val starts = LongArray(n) { segments[it * 2] }
          val ends = LongArray(n) { segments[it * 2 + 1] }
          t0 = System.currentTimeMillis()
          val json = NativeBridge.nativeTranscribe(
            audioPath, asrFile.absolutePath, RecordingService.SAMPLE_RATE, starts, ends, 0,
          )
          stageDone("asr", t0)
          val count = db.replaceUtterancesJson(meetingId, json)
          db.setStatus(meetingId, "asr")
          emitProgress(meetingId, "asr", 1, 1)
          transcribed = count > 0
          Log.i("AudioPipeline", "ASR produced $count utterances for $meetingId")
          if (checkCancelled(meetingId)) { promise.resolve(null); return@Thread }
        } else {
          // Two very different reasons to land here; saying "no model" for both sent me hunting
          // for a missing file when the real answer was that the recording had no speech in it.
          val why = if (segments.isEmpty()) "no speech detected" else "whisper model not installed"
          Log.i("AudioPipeline", "ASR skipped for $meetingId ($why)")
        }

        // ---- Diarization (sherpa-onnx), if the models are installed and we have a transcript ----
        val segModel = com.audionotes.data.ModelCatalog.fileFor(ctx, "diar-seg")
        val embModel = com.audionotes.data.ModelCatalog.fileFor(ctx, "diar-emb")
        if (transcribed && segModel != null && segModel.exists() && embModel != null && embModel.exists()) {
          emitProgress(meetingId, "diarize", 0, 1)
          t0 = System.currentTimeMillis()
          val tri = NativeBridge.nativeDiarize(
            audioPath, segModel.absolutePath, embModel.absolutePath, RecordingService.SAMPLE_RATE, 0,
          )
          stageDone("diarize", t0)
          val m = tri.size / 3
          if (m > 0) {
            val ds = LongArray(m) { tri[it * 3] }
            val de = LongArray(m) { tri[it * 3 + 1] }
            val sp = IntArray(m) { tri[it * 3 + 2].toInt() }
            db.assignSpeakers(meetingId, ds, de, sp)
            db.setStatus(meetingId, "diarized")
          }
          emitProgress(meetingId, "diarize", 1, 1)
          Log.i("AudioPipeline", "Diarization produced $m segments for $meetingId")
        } else if (transcribed) {
          Log.i("AudioPipeline", "Diarization skipped for $meetingId (no diar models installed yet)")
        }

        emitComplete(meetingId, "done")
        promise.resolve(null)
      } catch (e: Exception) {
        Log.e("AudioPipeline", "process failed", e)
        try { AudioDb.get(ctx).setStatus(meetingId, "error") } catch (_: Exception) {}
        emitComplete(meetingId, "error", e.message ?: e.toString())
        promise.reject("process_failed", e)
      } finally {
        cancelled.remove(meetingId)
      }
    }.start()
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
   * part-way, so this marks the meeting cancelled and process() checks between stages. A cancel
   * therefore takes effect at the next stage boundary rather than instantly — which is the right
   * trade: killing a thread mid-inference would leak the model and could corrupt the transcript
   * write. The audio and any completed stages are kept, so Reprocess can resume later.
   */
  @ReactMethod
  fun cancel(meetingId: String) {
    cancelled.add(meetingId)
    Log.i("AudioPipeline", "cancel requested for $meetingId (applies at the next stage boundary)")
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

  /** True if cancel() was called for this meeting; clears the flag so the next run is clean. */
  private fun checkCancelled(meetingId: String): Boolean {
    if (!cancelled.contains(meetingId)) return false
    cancelled.remove(meetingId)
    Log.i("AudioPipeline", "pipeline cancelled for $meetingId")
    emitComplete(meetingId, "cancelled")
    return true
  }

  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}

  /** Resolve the Silero VAD model, copying it out of assets on first use if bundled there. */
  private fun ensureVadModel(): String {
    val modelsDir = File(ctx.filesDir, "models").apply { mkdirs() }
    val model = File(modelsDir, "silero_vad.onnx")
    if (model.exists()) return model.absolutePath
    // Optional: bundle the ~1MB MIT model in android/app/src/main/assets/ for offline first-run.
    try {
      ctx.assets.open("silero_vad.onnx").use { input ->
        model.outputStream().use { input.copyTo(it) }
      }
      return model.absolutePath
    } catch (_: Exception) {
      throw IllegalStateException(
        "silero_vad.onnx not found — place it in assets/ or have ModelManager download it (milestone 2)",
      )
    }
  }

  /**
   * Terminal event for a pipeline run. The JS layer previously had no way to learn that
   * processing finished or failed — it polled the database on a timer instead, which meant a
   * failed run looked identical to a slow one.
   *
   * @param outcome one of: done | cancelled | error
   */
  private fun emitComplete(meetingId: String, outcome: String, message: String? = null) {
    val map = WritableNativeMap().apply {
      putString("meetingId", meetingId)
      putString("outcome", outcome)
      if (message != null) putString("message", message)
    }
    emit(if (outcome == "error") "onError" else "onStageComplete", map)
  }

  private fun emit(event: String, map: WritableNativeMap) {
    try {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(event, map)
    } catch (_: Exception) {
      // No JS context (app killed while processing continues) — events are advisory only.
    }
  }

  private fun emitProgress(meetingId: String, stage: String, done: Int, total: Int) {
    val map = WritableNativeMap().apply {
      putString("meetingId", meetingId)
      putString("stage", stage)
      putInt("chunk", done)
      putInt("total", total)
    }
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("onStageProgress", map)
  }
}
