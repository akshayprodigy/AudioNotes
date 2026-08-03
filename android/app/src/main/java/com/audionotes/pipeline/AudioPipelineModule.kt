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
    // RecordingService marks the meeting 'captured' (with real duration) in its onDestroy.
    stopLevelEmitter()
    CaptureController.stop(ctx)
    promise.resolve(null)
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
    Thread {
      try {
        val db = AudioDb.get(ctx)
        val audioPath = db.getAudioPath(meetingId)
          ?: throw IllegalStateException("no audio for $meetingId")
        val modelPath = ensureVadModel()

        emitProgress(meetingId, "vad", 0, 1)
        val segments = NativeBridge.nativeVad(audioPath, modelPath, RecordingService.SAMPLE_RATE)
        db.replaceSegments(meetingId, segments)
        db.setStatus(meetingId, "vad")
        emitProgress(meetingId, "vad", 1, 1)
        Log.i("AudioPipeline", "VAD produced ${segments.size / 2} speech segments for $meetingId")

        // ---- ASR (whisper.cpp) over the VAD spans, if the chosen model is installed ----
        val modelName = if (options.hasKey("model")) options.getString("model") ?: "base" else "base"
        val asrFile = com.audionotes.data.ModelCatalog.fileFor(ctx, com.audionotes.data.ModelCatalog.asrIdForModel(modelName))
        var transcribed = false
        if (segments.isNotEmpty() && asrFile != null && asrFile.exists()) {
          emitProgress(meetingId, "asr", 0, 1)
          val n = segments.size / 2
          val starts = LongArray(n) { segments[it * 2] }
          val ends = LongArray(n) { segments[it * 2 + 1] }
          val json = NativeBridge.nativeTranscribe(
            audioPath, asrFile.absolutePath, RecordingService.SAMPLE_RATE, starts, ends,
          )
          val count = db.replaceUtterancesJson(meetingId, json)
          db.setStatus(meetingId, "asr")
          emitProgress(meetingId, "asr", 1, 1)
          transcribed = count > 0
          Log.i("AudioPipeline", "ASR produced $count utterances for $meetingId")
        } else {
          Log.i("AudioPipeline", "ASR skipped for $meetingId (no whisper model installed yet)")
        }

        // ---- Diarization (sherpa-onnx), if the models are installed and we have a transcript ----
        val segModel = com.audionotes.data.ModelCatalog.fileFor(ctx, "diar-seg")
        val embModel = com.audionotes.data.ModelCatalog.fileFor(ctx, "diar-emb")
        if (transcribed && segModel != null && segModel.exists() && embModel != null && embModel.exists()) {
          emitProgress(meetingId, "diarize", 0, 1)
          val tri = NativeBridge.nativeDiarize(
            audioPath, segModel.absolutePath, embModel.absolutePath, RecordingService.SAMPLE_RATE, 0,
          )
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

        promise.resolve(null)
      } catch (e: Exception) {
        Log.e("AudioPipeline", "process failed", e)
        try { AudioDb.get(ctx).setStatus(meetingId, "error") } catch (_: Exception) {}
        promise.reject("process_failed", e)
      }
    }.start()
  }

  @ReactMethod
  fun cancel(meetingId: String) {
    // TODO(milestone 2+): cooperative cancel of the running pipeline.
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
