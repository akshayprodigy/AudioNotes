package com.innocorelabs.verbale.pipeline

import android.content.Context
import android.util.Log
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ModelCatalog
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
  /** Re-run narration even though prose already exists — the Summary tab's "Write it again". */
  private val forceNarrate: Boolean = false,
) {
  interface Listener {
    fun onStage(stage: String, done: Int, total: Int)
    fun onComplete(outcome: String, message: String? = null) // "done" | "cancelled" | "error"
    /** A pause began ([reason] non-null) or ended (null). Only ever sent on a change. */
    fun onPause(reason: ProcessingBudget.PauseReason?) {}
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

      // Retention deletes the recording once it has been transcribed, so a re-run can arrive with
      // a path that no longer resolves. VAD over a missing file returns nothing, and committing
      // that nothing wiped the spans of a meeting that still had a perfectly good transcript,
      // leaving it reading "0 segments, 0s of speech". So every stage that reads audio is skipped.
      //
      // Narration is NOT one of them. It reads the transcript and the speakers, never the audio —
      // and every meeting recorded before narration shipped is in exactly this state: transcribed,
      // audio long since reclaimed, no summary. Returning early here meant those meetings could
      // never get one, which is the entire population that needs it. Measured on a real 18-minute
      // recording from 2026-08-25 that answered "re-run skipped (audio deleted by retention)" to
      // the Summary tab's own "Write the summary" button.
      val audioGone = !File(audioPath).exists()
      if (audioGone && db.utterances(meetingId).isEmpty()) {
        // No audio AND no transcript: nothing to derive anything from, in either direction.
        Log.i(TAG, "re-run skipped for $meetingId (audio deleted, no transcript to fall back on)")
        listener.onComplete("done")
        return
      }
      if (audioGone) Log.i(TAG, "audio gone for $meetingId — transcript-only re-run")

      val state = db.pipelineState(meetingId)
      // Leaving the refused state: whatever one-liner this meeting carries was written before or
      // during a refusal and does not describe the transcript we are about to produce.
      if (state.status == "unsupported_language") db.clearSummaryLine(meetingId)
      val remaining = ResumePlan.remaining(state, forceNarrate)
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
      // [pausedAtStart] is `pausedMs` when the stage began: a thermal pause inside the stage is
      // wall time, not work, and must not teach the ETA that this phone is slow.
      fun stageDone(stage: String, startedAt: Long, pausedAtStart: Long) {
        val ms = System.currentTimeMillis() - startedAt
        val paused = pausedMs - pausedAtStart
        val rt = StageRates.measured(ms, paused, audioMs)
        Log.i(TAG, "stage=%s %dms (%.2fx realtime, %dms paused) audio=%ds %s"
          .format(stage, ms, rt, paused, audioMs / 1000, meetingId))
        // What this phone learns for the next ETA. Never on a cancelled stage: a run cut short
        // measures the cut, not the stage.
        if (!cancelled) {
          StageRates.next(db.stageRate(stage), rt, audioMs)?.let { db.setStageRate(stage, it) }
        }
      }

      if (Stage.VAD in remaining && !audioGone) {
        awaitClearance()
        listener.onStage("vad", 0, 1)
        val modelPath = ensureVadModel()
        val t0 = System.currentTimeMillis(); val p0 = pausedMs
        val seg = NativeBridge.nativeVad(audioPath, modelPath, RecordingService.SAMPLE_RATE)
        stageDone("vad", t0, p0)
        db.replaceSegments(meetingId, seg)
        db.setStatus(meetingId, "vad")
        listener.onStage("vad", 1, 1)
        Log.i(TAG, "VAD produced ${seg.size / 2} speech segments for $meetingId")
        if (checkCancelled()) return
      }

      // Load spans from the DB so ASR works whether VAD ran THIS session or a previous one.
      // Then keep the spoken consent clip out of them: whisper cannot read it, and a window that
      // opens with it drops the speech after it (AnnouncementSpan). The stored spans and the audio
      // are untouched; this is only what the recogniser is asked to read.
      val spans = announcementFree(db, meetingId, db.segments(meetingId))

      // ---- ASR (whisper.cpp) over the VAD spans, if the chosen model is installed ----
      // Stage.ASR not being in `remaining` means utterances already exist from a prior session —
      // treat that the same as "transcribed" so a diarize-only resume still runs below.
      var transcribed = Stage.ASR !in remaining
      if (Stage.ASR in remaining && !audioGone) {
        val asrFile = ModelCatalog.fileFor(ctx, ModelCatalog.asrIdForModel(model))
        if (spans.isNotEmpty() && asrFile != null && asrFile.exists()) {
          awaitClearance()
          listener.onStage("asr", 0, 1)
          val n = spans.size / 2
          val starts = LongArray(n) { spans[it * 2] }
          val ends = LongArray(n) { spans[it * 2 + 1] }
          val t0 = System.currentTimeMillis(); val p0 = pausedMs

          // The language SPOKEN in the meeting, from Settings, resolved HERE rather than at
          // capture. Every entry point then behaves the same — a recording started from the app,
          // the Quick Settings tile or the PiP window all reach this one line — and, more to the
          // point, somebody whose meeting came back in the wrong script can pin the language and
          // reprocess, which would be impossible if the choice were frozen when they hit record.
          val language = db.getSetting("asrLanguage")?.takeIf { it.isNotBlank() } ?: "en"
          // Where a Qwen3-ASR export lives if one has been installed. Passed on every run, not
          // only Hindi ones: the ENGINE choice belongs to the core's policy table, and deciding
          // it here as well would put the same rule in two places that could disagree.
          // Set by "Transcribe it anyway" on a meeting this build already refused. Read per run
          // rather than held, so a reprocess of a forced meeting stays forced.
          val forced = db.transcribeForcedAt(meetingId) != null
          val qwen3Dir = ModelCatalog.qwen3DirFor(ctx)
          // Windows the live pass decoded while this meeting was still being recorded. Whisper
          // uses one only when the boundaries match EXACTLY, so a cache built against different
          // VAD spans costs a decode and never a wrong word. Read ONCE, here: a window cached
          // after this line is not looked at, which is why LiveTranscriber bounds its drain.
          val (cachedRanges, cachedJson) = db.cachedWindows(meetingId, asrFile.name)
          if (cachedJson.isNotEmpty()) {
            Log.i(TAG, "live pass offers ${cachedJson.size} window(s) for $meetingId")
          }
          val json = NativeBridge.nativeTranscribe(
            audioPath, asrFile.absolutePath, RecordingService.SAMPLE_RATE, starts, ends, 0, language,
            if (qwen3Dir.isDirectory) qwen3Dir.absolutePath else "", forced,
            cachedRanges, cachedJson, progressFor("asr"),
          )
          // An abort between windows returns the windows decoded so far. Persisting them would
          // leave `status = asr` over a partial transcript, and the next run's ResumePlan would
          // skip ASR and build minutes on half a meeting. Cancelled means nothing is written.
          if (checkCancelled()) return
          stageDone("asr", t0, p0)

          // The core answers with an object, not a bare array, so that "we refused to read this"
          // is tellable from "nobody spoke". Both would otherwise arrive as an empty list and the
          // stages below would write minutes over nothing.
          val asr = org.json.JSONObject(json)
          if (asr.optBoolean("unsupported_language", false)) {
            val heard = asr.optString("detected_language", "")
            // Record what was actually HEARD rather than what was asked for. The setting still
            // says English; the meeting was not, and the person needs to be told which.
            db.setLanguage(meetingId, heard.ifBlank { language })
            db.setStatus(meetingId, "unsupported_language")
            // NOT written into summary_line. That field is what the meeting was about, and the app
            // shows it wherever a summary belongs — so putting a status message in it meant a
            // recording that was later transcribed successfully still led with "this sounds like
            // Turkish", because only narration overwrites the field and narration is Pro-gated.
            // status + language already say everything; the sentence is composed where it is shown.
            db.clearSummaryLine(meetingId)
            listener.onStage("asr", 1, 1)
            // Returning stops diarization, minutes and narration for this meeting. That is the
            // entire point: a summary assembled over audio we cannot read is indistinguishable
            // from a real one to anybody who was not in the room. The audio is kept, so the
            // meeting can be reprocessed the day the language is supported.
            Log.i(TAG, "refused $meetingId: heard '$heard', which this build cannot transcribe")
            // Terminal, so it must be reported like every other terminal path. Returning without
            // this left the service running and the screen on "Writing your notes..." forever:
            // the refusal reached the database and never reached the person waiting on it.
            // "done" rather than "error" because nothing failed, and ProcessingService re-reads
            // the meeting's own status before notifying — so a refused meeting completes quietly
            // instead of announcing notes that were never written.
            listener.onComplete("done")
            return
          }

          // `language` records what the meeting was transcribed IN, so a forced run correctly
          // sets it to the requested code. `forced_from_language` is a different fact — what was
          // heard before somebody overruled us — written once by the app and never touched here.
          // Clearing it would empty the banner without breaking anything, which is the whole
          // reason it is a separate column.
          db.setLanguage(meetingId, language)
          val count = db.replaceUtterancesJson(meetingId, asr.getJSONArray("utterances").toString())
          db.setStatus(meetingId, "asr")
          // Scaffolding, not a record. Once utterances exist the cache's only remaining use is
          // making a Redo faster, and a Redo is explicitly a request to recompute. Keeping it
          // would leave a second copy of transcript text to honour in retention sweeps, in
          // exports and in the privacy summary; deleting it is the smaller promise.
          db.clearCachedWindows(meetingId)
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
      if (Stage.DIARIZE in remaining && !audioGone) {
        if (checkCancelled()) return
        val segModel = ModelCatalog.fileFor(ctx, "diar-seg")
        val embModel = ModelCatalog.fileFor(ctx, "diar-emb")
        if (transcribed && segModel != null && segModel.exists() && embModel != null && embModel.exists()) {
          // Can this phone afford to work out who spoke? This is the only stage whose working set
          // follows the LENGTH of the meeting, and an hour to ninety minutes is ordinary here —
          // rooms full of people run over in a way calls do not. Measured on a 12 GB Pixel, a
          // 90-minute recording reached 2.55 GB; a 4 GB phone would not have survived it.
          //
          // The answer is whole-meeting or nothing. Diarizing in windows was built and measured
          // and costs 6 DER points, because each window has to guess which of its speakers were in
          // the last one — and speaker labels that are confidently wrong are worse than none.
          val freeBytes = DiarBudget.availableBytes(ctx)
          val speechMs = DiarBudget.paddedSpeechUpperBoundMs(
            spans, File(audioPath).length() / 2 * 1000 / RecordingService.SAMPLE_RATE,
          )
          val windowMs = DiarBudget.windowMsFor(freeBytes, speechMs)
          if (windowMs == DiarBudget.SKIP) {
            // Best-effort, and this is what that means when it is not free. Losing speaker labels
            // costs the user a Redo on a less busy phone; being killed mid-diarization costs them
            // the meeting, because minutes and narration both come after this.
            db.setDiarSkippedReason(meetingId, DiarBudget.SKIPPED_FOR_MEMORY)
            // The stage is over, so say so. Without this the progress screen sits on "Speakers
            // separated" for the whole of minutes and narration, counting down an estimate for
            // work that will never run. The meeting's status stays where it is on purpose — it
            // records what happened, and diarization did not.
            listener.onStage("diarize", 1, 1)
            // The two numbers that decide this are the phone's, not ours, so a field report is
            // only diagnosable if they are in the log next to the decision.
            Log.w(TAG, "Diarization skipped for $meetingId: ${DiarBudget.describe(freeBytes, speechMs)}")
          } else {
            awaitClearance()
            listener.onStage("diarize", 0, 1)
            val t0 = System.currentTimeMillis(); val p0 = pausedMs
            // Hand VAD's spans over rather than the whole recording: worth 13-38% of the audio on
            // a real meeting and measurably better for attribution (mean DER 20.4 -> 20.0). It is
            // NOT a bound — most of a meeting is speech — which is what the check above is for.
            // `spans` is the same flat array ASR already works from.
            val tri = NativeBridge.nativeDiarize(
              audioPath, segModel.absolutePath, embModel.absolutePath, RecordingService.SAMPLE_RATE, 0,
              spans, windowMs, progressFor("diarize"),
            )
            // sherpa cannot abort mid-call, so a cancel (a Delete, say) lands here with a full
            // result for a meeting that may no longer exist: writing it raised a FOREIGN KEY
            // failure on the Pixel. Cancelled means nothing is written, as with ASR above.
            if (checkCancelled()) return
            stageDone("diarize", t0, p0)
            val m = tri.size / 3
            if (m > 0) {
              val ds = LongArray(m) { tri[it * 3] }
              val de = LongArray(m) { tri[it * 3 + 1] }
              val sp = IntArray(m) { tri[it * 3 + 2].toInt() }
              db.assignSpeakers(meetingId, ds, de, sp)
              db.setStatus(meetingId, "diarized")
            }
            // A meeting reprocessed on a phone with room must stop saying it ran out of it.
            db.setDiarSkippedReason(meetingId, null)
            listener.onStage("diarize", 1, 1)
            Log.i(TAG, "Diarization produced $m segments for $meetingId")
          }
        } else if (transcribed) {
          Log.i(TAG, "Diarization skipped for $meetingId (no diar models installed yet)")
        }
      }

      // ---- Minutes / MOM (rule-based, native), then narration, retitle, retention, done ----
      // Gate only on utterances existing — NOT on `transcribed`/diarize success. Diarize can
      // legitimately produce no speakers (single-speaker meeting, or no diar models installed
      // yet) and the meeting still deserves a full MOM from whatever transcript it has.
      val utts = db.utterances(meetingId)
      if (utts.isNotEmpty()) {
        awaitClearance()
        listener.onStage("minutes", 0, 1)
        val tMinutes = System.currentTimeMillis(); val pMinutes = pausedMs
        val speakers = db.speakers(meetingId)
        val minutes = Minutes.extract(utts, speakers)
        db.replaceMinutes(meetingId, "rule", minutes)

        // The same rules again, this time keeping the provenance `extract` throws away: which turn
        // said it, when, and where in that turn. `replaceMinutes` still runs and is not redundant
        // — `minutes` keeps the summary row, which is the free tier's overview paragraph and which
        // the export renderer reads.
        //
        // Both reads are of `utts`, which already carries the ids and timings for exactly this:
        // a second query over the same rows is a second chance for the two to be a row apart, and
        // that produces no error, only items anchored at the wrong moment.
        val items = Minutes.extractItems(utts, speakers)
        db.replaceItems(meetingId, Minutes.RULES_GEN, items)

        retitleFromTranscript(meetingId, utts)

        // ---- Meeting type (Phase 2, sub-project 6a) ----
        //
        // After the rule pass, before narration — Narrator.run reads meetings.template on this
        // same call and passes it to narrativePrompt, so suggesting it any later would narrate
        // with last run's type. Never over a person's own pick: 'chosen' is the one value this
        // must not call setTemplate over, which is the whole reason it reads templateSource
        // first rather than just checking template for null.
        //
        // Cheap and synchronous — a cue-word scan over utterances already in memory, no model —
        // so it carries none of the awaitClearance/stageDone ceremony narration and embedding
        // below need, and a failure here costs the meeting a label, never the minutes.
        try {
          suggestTemplate(db, meetingId, utts, speakers.size)
        } catch (e: Throwable) {
          Log.w(TAG, "template suggestion failed for $meetingId", e)
        }

        stageDone("minutes", tMinutes, pMinutes)
        listener.onStage("minutes", 1, 1)
        Log.i(TAG, "Minutes produced ${minutes.size} rows and ${items.size} items for $meetingId")

        // ---- Narration (on-device LLM): the summary, the MOM prose, the library one-liner ----
        //
        // This is the whole reason a meeting stopped from the PiP window or the notification now
        // ends up readable: the enhancement used to live in JS (PipelineController.enhanceMinutes)
        // and only ran when the app happened to be in the foreground, so a headless recording got
        // rule-based minutes and a summary that was a count of its own items.
        //
        // Placed BEFORE applyRetention deliberately. Retention deletes the audio, which is what
        // makes a meeting unrecoverable; if narration fails we want the recording still on disk so
        // a later sweep can try again. It also writes source='llm' rows only, so a failure here
        // costs the meeting nothing it already had.
        if (Stage.NARRATE in remaining) {
          awaitClearance()
          val t0 = System.currentTimeMillis(); val p0 = pausedMs
          val narrated = try {
            Narrator.run(ctx, meetingId, object : Narrator.Progress {
              override fun onStage(stage: String, done: Int, total: Int) {
                listener.onStage(stage, done, total)
                awaitClearance()
              }

              override fun isCancelled(): Boolean = cancelled
            })
          } catch (e: Throwable) {
            // Throwable, not Exception: an OutOfMemoryError while a 1.1 GB model is resident is
            // the plausible failure on a 3 GB phone, and it must not cost the user the transcript
            // and rule minutes already committed above.
            Log.w(TAG, "narration failed for $meetingId", e)
            false
          }
          if (narrated) stageDone("narrate", t0, p0)
          if (checkCancelled()) return
        }

        // ---- Meaning index (Pro): vectors for search and Ask ----
        //
        // After narration so the summary it embeds is the written one. Idempotent by hash, so a
        // reprocess re-embeds only the windows whose words changed; a free user or a phone
        // without the model skips it silently, and the JS sweep's backfill is the retry. Not a
        // ResumePlan stage: a meeting without vectors is complete, not resumable.
        if (EmbedRuntime.available(ctx)) {
          awaitClearance()
          val t0 = System.currentTimeMillis(); val p0 = pausedMs
          val embedded = try {
            Embedder.fill(
              ctx, meetingId,
              onProgress = { d, t -> listener.onStage("embed", d, t) },
              pause = { awaitClearance() },
            )
          } catch (e: Throwable) {
            Log.w(TAG, "embedding failed for $meetingId", e)
            false
          }
          if (embedded) stageDone("embed", t0, p0)
          if (checkCancelled()) return
        }

        if (!audioGone) applyRetention(meetingId, utts.size)
        db.setStatus(meetingId, "done")
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


  /** Blocks while the phone is too hot or too flat, announcing the pause and the resume once each. */
  private fun awaitClearance() {
    var reason = reasonToPause(null) ?: return
    val since = System.currentTimeMillis()
    Log.i(TAG, "pause $reason: ${budgetLine()} $meetingId")
    listener.onPause(reason)
    while (!cancelled) {
      Thread.sleep(ProcessingBudget.POLL_MS)
      reason = reasonToPause(reason) ?: break
    }
    pausedMs += System.currentTimeMillis() - since
    Log.i(TAG, "resume after ${System.currentTimeMillis() - since}ms: ${budgetLine()} $meetingId")
    listener.onPause(null)
  }

  /** Wall time this run has spent paused so far; each stage measures itself net of it. */
  @Volatile private var pausedMs = 0L

  private fun reasonToPause(current: ProcessingBudget.PauseReason?) = ProcessingBudget.reasonToPause(
    LiveBudget.thermalStatus(ctx), LiveBudget.batteryPercent(ctx), LiveBudget.isCharging(ctx), current,
  )

  private fun budgetLine() =
    "thermal=${LiveBudget.thermalStatus(ctx)} battery=${LiveBudget.batteryPercent(ctx)} charging=${LiveBudget.isCharging(ctx)}"

  /** Between units of work inside a native stage: report, wait out a pause, say whether to go on. */
  private fun progressFor(stage: String) = NativeBridge.StageProgress { done, total ->
    listener.onStage(stage, done, total)
    awaitClearance()
    !cancelled
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
      val trimmed = stripOpeningFiller(opening)
      var title = trimmed.take(60)
      val sentenceEnd = title.indexOfFirst { it == '.' || it == '!' || it == '?' }
      if (sentenceEnd > 15) {
        title = title.substring(0, sentenceEnd)
      } else if (trimmed.length > 60) {
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
      if (utteranceCount == 0) return // no transcript — the audio is all we have, keep it

      // Only the "delete as soon as it is transcribed" setting deletes HERE. Every other window
      // is the sweep's business (AudioRetention.sweep), which runs against created_at.
      //
      // This used to be `keepAudio != "1"`, which deleted the recording on a fresh install: the
      // boolean is only written once the user opens Settings, so a phone that had never expressed
      // an opinion took the strictest branch. That made the 7-day default a lie for exactly the
      // people it was introduced for, and playback impossible on every meeting they had recorded.
      if (AudioRetention.daysFor(db) != 0) return

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

  /**
   * [spans] with the located consent clip removed — see AnnouncementSpan for why. A meeting with
   * no stamp, or one stamped before the lag was recorded, comes back unchanged.
   */
  private fun announcementFree(db: AudioDb, meetingId: String, spans: LongArray): LongArray {
    val lag = db.announcedLagMs(meetingId) ?: return spans
    val clipMs = AnnouncementPlayer.bundledClipMs(ctx) ?: return spans
    val out = AnnouncementSpan.exclude(spans, lag, lag + clipMs)
    if (out.size != spans.size) {
      Log.i(TAG, "announcement at ${lag}ms kept out of ASR: ${spans.size / 2} span(s) -> ${out.size / 2}")
    }
    return out
  }

  companion object {
    private const val TAG = "AudioPipeline"

    /**
     * Phase 2 (sub-project 6a): suggest a meeting's type from its transcript, unless a person
     * already chose one — the exact guard [run] applies, pulled out to a plain function so
     * TemplatesDbTest can call it directly without a transcript pass. Never over `chosen`: that
     * is the one value TemplateSuggester's own answer must not replace.
     */
    internal fun suggestTemplate(db: AudioDb, meetingId: String, utts: List<Utt>, speakerCount: Int) {
      if (db.templateSource(meetingId) == AudioDb.TemplateSource.CHOSEN) return
      val transcript = utts.joinToString(" ") { it.text }
      val remembered = db.rememberedTemplate(db.tagsFor(meetingId))
      val suggested = TemplateSuggester.suggest(transcript, speakerCount, remembered)
      db.setTemplate(meetingId, suggested, AudioDb.TemplateSource.SUGGESTED)
    }

    // Mirrors the JS-generated-title guard in PipelineController.retitleFromTranscript exactly:
    // / meeting · /.test(current) — a space, "meeting", a middle-dot, a space.
    private val RETITLE_PLACEHOLDER = Regex(""" meeting · """)
    private val WHITESPACE_RUN = Regex("""\s+""")
    private val TRAILING_PARTIAL_WORD = Regex("""\s+\S*$""")

    /**
     * Leading filler, dropped from an auto-title.
     *
     * MIRRORS stripOpeningFiller in src/pipeline/PipelineController.ts, and the list must stay
     * identical: Android titles headlessly through this path while the JS path titles the same
     * recording when the app drives it, so a word removed on one side only means the same meeting
     * gets two different names depending on who processed it.
     *
     * Meetings open with throat-clearing. "So there are three different stages to the design" is a
     * real auto-title off a real recording, and the first word is the only one a reader skips.
     */
    private val OPENING_FILLER = Regex(
      "^(so|okay|ok|um|uh|erm|ah|oh|right|yeah|yep|yes|well|alright|anyway|now|and|but|like" +
        "|basically|actually)\\b,?\\s+",
      RegexOption.IGNORE_CASE,
    )

    fun stripOpeningFiller(opening: String): String {
      var out = opening
      // A floor, not a nicety: without it "So, right" strips to "" and the meeting loses its name.
      while (out.length > 15) {
        val next = OPENING_FILLER.replaceFirst(out, "")
        if (next == out || next.length < 15) break
        out = next
      }
      return out
    }
  }
}
