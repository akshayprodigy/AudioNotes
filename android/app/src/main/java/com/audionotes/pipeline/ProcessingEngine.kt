package com.audionotes.pipeline

import android.content.Context
import android.util.Log
import com.audionotes.data.AudioDb
import com.audionotes.data.ModelCatalog
import java.io.File

/**
 * Runs a meeting's remaining native pipeline stages (VAD → ASR → diarize), skipping any stage whose
 * output rows already exist (resume-by-stage — see ResumePlan). Extracted from AudioPipelineModule
 * so it can run inside a foreground service (later task). Progress/terminal state is reported
 * through [Listener]; this class does no RN/bridge work itself.
 *
 * Callers must have already resolved a meeting still in 'recording' to 'captured'/'error'
 * (recoverOrphanedRecordings) before running — ResumePlan assumes it never sees 'recording'.
 */
class ProcessingEngine(
  private val ctx: Context,
  private val meetingId: String,
  private val model: String,
  private val listener: Listener,
) {
  interface Listener {
    fun onStage(stage: String, done: Int, total: Int)
    fun onComplete(outcome: String, message: String? = null) // "done" | "cancelled" | "error"
  }

  @Volatile var cancelled = false

  fun run() {
    try {
      // Loads libaudionotes.so, first System.load()ing the downloaded libonnxruntime.so it
      // depends on (kept out of the APK). Throws a clear error if that download is missing,
      // which the catch below surfaces as a failed run rather than a native crash.
      NativeBridge.ensureLoaded(ctx)
      val db = AudioDb.get(ctx)
      val audioPath = db.getAudioPath(meetingId)
        ?: throw IllegalStateException("no audio for $meetingId")

      // Retention deletes the recording once it has been transcribed, so a re-run can arrive
      // with a path that no longer resolves. VAD over a missing file returns nothing, and the
      // old code committed that nothing — replaceSegments wiped the spans of a meeting that
      // still had a perfectly good transcript, leaving it reading "0 segments, 0s of speech".
      // With no audio there is nothing to re-derive, so leave the stored results alone and let
      // the caller rebuild the minutes from the transcript it already has.
      if (!File(audioPath).exists()) {
        Log.i(TAG, "re-run skipped for $meetingId (audio deleted by retention)")
        return
      }

      val remaining = ResumePlan.remaining(db.pipelineState(meetingId))
      if (remaining.isEmpty()) { listener.onComplete("done"); return }

      // Per-stage wall times, logged against the audio length so the numbers are comparable
      // between recordings and against DiarEmbeddingBench. Without these the only timing signal
      // was the gap between two log lines, which attributes queueing and DB writes to whichever
      // stage happened to log next — enough to make a stage look 10x slower than it measures in
      // isolation.
      val audioMs = File(audioPath).length() / 32
      fun stageDone(stage: String, startedAt: Long) {
        val ms = System.currentTimeMillis() - startedAt
        val rt = if (audioMs > 0) ms.toDouble() / audioMs else 0.0
        Log.i(TAG, "stage=%s %dms (%.2fx realtime) audio=%ds %s"
          .format(stage, ms, rt, audioMs / 1000, meetingId))
      }

      if (Stage.VAD in remaining) {
        listener.onStage("vad", 0, 1)
        val modelPath = ensureVadModel()
        val t0 = System.currentTimeMillis()
        val seg = NativeBridge.nativeVad(audioPath, modelPath, RecordingService.SAMPLE_RATE)
        stageDone("vad", t0)
        db.replaceSegments(meetingId, seg)
        db.setStatus(meetingId, "vad")
        listener.onStage("vad", 1, 1)
        Log.i(TAG, "VAD produced ${seg.size / 2} speech segments for $meetingId")
        if (checkCancelled()) return
      }

      // Load spans from the DB so ASR works whether VAD ran THIS session or a previous one.
      val spans = db.segments(meetingId)

      // ---- ASR (whisper.cpp) over the VAD spans, if the chosen model is installed ----
      // Stage.ASR not being in `remaining` means utterances already exist from a prior session —
      // treat that the same as "transcribed" so a diarize-only resume still runs below.
      var transcribed = Stage.ASR !in remaining
      if (Stage.ASR in remaining) {
        val asrFile = ModelCatalog.fileFor(ctx, ModelCatalog.asrIdForModel(model))
        if (spans.isNotEmpty() && asrFile != null && asrFile.exists()) {
          listener.onStage("asr", 0, 1)
          val n = spans.size / 2
          val starts = LongArray(n) { spans[it * 2] }
          val ends = LongArray(n) { spans[it * 2 + 1] }
          val t0 = System.currentTimeMillis()
          val json = NativeBridge.nativeTranscribe(
            audioPath, asrFile.absolutePath, RecordingService.SAMPLE_RATE, starts, ends, 0,
          )
          stageDone("asr", t0)
          val count = db.replaceUtterancesJson(meetingId, json)
          db.setStatus(meetingId, "asr")
          listener.onStage("asr", 1, 1)
          transcribed = count > 0
          Log.i(TAG, "ASR produced $count utterances for $meetingId")
          if (checkCancelled()) return
        } else {
          // Two very different reasons to land here; saying "no model" for both sent me hunting
          // for a missing file when the real answer was that the recording had no speech in it.
          val why = if (spans.isEmpty()) "no speech detected" else "whisper model not installed"
          Log.i(TAG, "ASR skipped for $meetingId ($why)")
        }
      }

      // ---- Diarization (sherpa-onnx), if the models are installed and we have a transcript ----
      if (Stage.DIARIZE in remaining) {
        if (checkCancelled()) return
        val segModel = ModelCatalog.fileFor(ctx, "diar-seg")
        val embModel = ModelCatalog.fileFor(ctx, "diar-emb")
        if (transcribed && segModel != null && segModel.exists() && embModel != null && embModel.exists()) {
          listener.onStage("diarize", 0, 1)
          val t0 = System.currentTimeMillis()
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
          listener.onStage("diarize", 1, 1)
          Log.i(TAG, "Diarization produced $m segments for $meetingId")
        } else if (transcribed) {
          Log.i(TAG, "Diarization skipped for $meetingId (no diar models installed yet)")
        }
      }

      listener.onComplete("done")
    } catch (e: Exception) {
      Log.e(TAG, "process failed for $meetingId", e)
      try { AudioDb.get(ctx).setStatus(meetingId, "error") } catch (_: Exception) {}
      listener.onComplete("error", e.message ?: e.toString())
    }
  }

  private fun checkCancelled(): Boolean {
    if (!cancelled) return false
    Log.i(TAG, "pipeline cancelled for $meetingId")
    listener.onComplete("cancelled")
    return true
  }

  /** Resolve the Silero VAD model, copying it out of assets on first use if bundled there. */
  private fun ensureVadModel(): String {
    val modelsDir = File(ctx.filesDir, "models").apply { mkdirs() }
    val modelFile = File(modelsDir, "silero_vad.onnx")
    if (modelFile.exists()) return modelFile.absolutePath
    // Optional: bundle the ~1MB MIT model in android/app/src/main/assets/ for offline first-run.
    try {
      ctx.assets.open("silero_vad.onnx").use { input ->
        modelFile.outputStream().use { input.copyTo(it) }
      }
      return modelFile.absolutePath
    } catch (_: Exception) {
      throw IllegalStateException(
        "silero_vad.onnx not found — place it in assets/ or have ModelManager download it (milestone 2)",
      )
    }
  }

  companion object { private const val TAG = "AudioPipeline" }
}
