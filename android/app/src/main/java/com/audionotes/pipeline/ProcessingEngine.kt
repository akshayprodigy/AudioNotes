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
        listener.onComplete("done")
        return
      }

      val state = db.pipelineState(meetingId)
      val remaining = ResumePlan.remaining(state)
      // Rows-only isn't enough: if the native minutes stage previously threw (e.g. replaceMinutes)
      // the outer catch sets status='error' while every stage's rows are already present, and a
      // rows-only check would report "done" here without ever re-running the minutes stage —
      // stranding the meeting with no minutes forever. Require status=='done' too.
      if (remaining.isEmpty() && state.status == "done") { listener.onComplete("done"); return }

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

      // ---- Minutes / MOM (rule-based, native) + retitle + retention, then done ----
      // Gate only on utterances existing — NOT on `transcribed`/diarize success. Diarize can
      // legitimately produce no speakers (single-speaker meeting, or no diar models installed
      // yet) and the meeting still deserves a full MOM from whatever transcript it has.
      val utts = db.utterances(meetingId)
      if (utts.isNotEmpty()) {
        val speakers = db.speakers(meetingId)
        val minutes = MinutesExtractor.extract(utts, speakers)
        db.replaceMinutes(meetingId, minutes)
        retitleFromTranscript(meetingId, utts)
        applyRetention(meetingId, utts.size)
        db.setStatus(meetingId, "done")
        Log.i(TAG, "Minutes produced ${minutes.size} items for $meetingId")
      } else {
        // No transcript. Port of PipelineController.buildMinutes' empty-utterances branch
        // (src/pipeline/PipelineController.ts ~183-208, post-33b0c94) — terminal classification
        // only when we KNOW re-running would produce the same nothing; otherwise leave pending
        // so the next sweep retries once the model/state catches up.
        //
        // No spans at all: the recording genuinely contains no speech. Re-running VAD on the
        // same silent audio yields the same nothing, so mark terminal ('error' -> "NO SPEECH").
        if (spans.isEmpty()) {
          db.setStatus(meetingId, "error")
        } else if (db.pipelineState(meetingId).status == "asr") {
          // Read fresh (not the `state` cached at the top of run()) so this reflects THIS pass's
          // ASR stage having just called db.setStatus(meetingId, "asr") above — otherwise a
          // same-pass blank transcription (model present, spans exist, zero utterances) would
          // read the stale pre-ASR status and wrongly fall through to "leave pending", stranding
          // a headless one-shot run (no later sweep to converge it) forever. Spans exist and ASR
          // actually ran (status only reaches 'asr' when the whisper model was present) but
          // produced zero utterances (music/noise/unintelligible) — re-running transcribes the
          // same audio to the same nothing, so mark terminal instead of being re-swept forever.
          db.setStatus(meetingId, "error")
        }
        // else: status is still 'vad'/'captured' -> ASR hasn't run yet (model still downloading)
        // -> leave pending for the next sweep to retry, no status change.
      }

      listener.onComplete("done")
    } catch (e: Throwable) {
      // Must catch Throwable, not just Exception: an OutOfMemoryError/LinkageError during a stage
      // (plausible on-device during diarization on a low-RAM phone) is not an Exception, and JS
      // sweep() now awaits this run's terminal event — missing it wedges that one meeting forever
      // and blocks the whole sweep loop for the rest of the app session.
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

  /**
   * Native port of PipelineController.retitleFromTranscript (src/pipeline/PipelineController.ts:
   * ~223-249). Replaces the timestamp-placeholder title with the opening line of the meeting —
   * what people actually remember is how a meeting started. Only overwrites a title the app
   * generated itself (JS guard, matched exactly below), so a rename by the user is never
   * clobbered. Titling is cosmetic, so this never fails the pipeline.
   */
  private fun retitleFromTranscript(meetingId: String, utts: List<Utt>) {
    try {
      val db = AudioDb.get(ctx)
      val current = db.getTitle(meetingId) ?: ""
      // JS: const isGenerated = current === 'Meeting' || / meeting · /.test(current);
      val isGenerated = current == "Meeting" || RETITLE_PLACEHOLDER.containsMatchIn(current)
      if (!isGenerated) return

      // JS: utterances.map(u => u.text.trim()).filter(Boolean).join(' ').replace(/\s+/g,' ').trim()
      val opening = utts.map { it.text.trim() }
        .filter { it.isNotEmpty() }
        .joinToString(" ")
        .replace(WHITESPACE_RUN, " ")
        .trim()
      if (opening.length < 8) return

      // Cut at a sentence end when there is one close by, otherwise on a word boundary.
      // JS: let title = opening.slice(0, 60);
      //     const sentenceEnd = title.search(/[.!?]/);
      //     if (sentenceEnd > 15) title = title.slice(0, sentenceEnd);
      //     else if (opening.length > 60) title = title.replace(/\s+\S*$/, '') + '…';
      var title = opening.take(60)
      val sentenceEnd = title.indexOfFirst { it == '.' || it == '!' || it == '?' }
      if (sentenceEnd > 15) {
        title = title.substring(0, sentenceEnd)
      } else if (opening.length > 60) {
        title = title.replace(TRAILING_PARTIAL_WORD, "") + "…"
      }

      title = title.replaceFirstChar { it.uppercaseChar() }
      db.setTitle(meetingId, title)
    } catch (_: Throwable) {
      // Titling is cosmetic — never let it fail the pipeline.
    }
  }

  /**
   * Native port of PipelineController.applyRetention (src/pipeline/PipelineController.ts:
   * ~113-123). Default is to delete the raw PCM once a transcript exists — unencrypted audio at
   * ~115 MB/hour whose only remaining use after transcription is Reprocess. Keeping it is opt-in
   * via the `keepAudio` setting. Only ever discards when a transcript actually exists, so a
   * failed ASR run never destroys the only copy of the meeting. Retention is best-effort and
   * never fails a good transcript over cleanup.
   */
  private fun applyRetention(meetingId: String, utteranceCount: Int) {
    try {
      val db = AudioDb.get(ctx)
      if (db.getSetting("keepAudio") == "1") return // user opted to keep audio
      if (utteranceCount == 0) return // no transcript — the audio is all we have, keep it

      // Delete pattern reused from AudioPipelineModule.discardAudio.
      val path = db.getAudioPath(meetingId)
      if (path != null) {
        val f = File(path)
        if (f.exists() && !f.delete()) {
          Log.w(TAG, "could not delete audio for $meetingId")
        }
      }
      db.setAudioRetained(meetingId, false)
    } catch (_: Throwable) {
      // Retention is best-effort; never fail a good transcript over cleanup.
    }
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

  companion object {
    private const val TAG = "AudioPipeline"

    // Mirrors the JS-generated-title guard in PipelineController.retitleFromTranscript exactly:
    // / meeting · /.test(current) — a space, "meeting", a middle-dot, a space.
    private val RETITLE_PLACEHOLDER = Regex(""" meeting · """)
    private val WHITESPACE_RUN = Regex("""\s+""")
    private val TRAILING_PARTIAL_WORD = Regex("""\s+\S*$""")
  }
}
