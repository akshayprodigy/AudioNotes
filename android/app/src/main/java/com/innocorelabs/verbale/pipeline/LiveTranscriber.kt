package com.innocorelabs.verbale.pipeline

import android.content.Context
import android.util.Log
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ModelCatalog
import java.io.File
import kotlin.concurrent.thread

/**
 * Transcribes a meeting WHILE it is being recorded, so the wait after "stop" is roughly halved.
 *
 * It tails the PCM file rather than tapping the capture thread. That is the whole safety story:
 * the recorder's loop is untouched, so ASR cannot starve it even in principle, and audio the user
 * paused — discarded, never written — is simply audio this reader never sees.
 *
 * NOTHING HERE DECIDES ANYTHING. It decodes windows and stores them; the post-hoc pipeline still
 * runs in full and still owns language refusal, alignment and minutes. A window this class fails
 * to reach is decoded later exactly as it always was, so every failure path — a slow phone, a
 * thermal backoff, a crash mid-meeting — degrades to the behaviour that shipped before this file
 * existed. `scripts/check-live-transcript.py` fails the build if that stops being true.
 *
 * See docs/superpowers/specs/2026-09-07-live-transcript-design.md.
 */
class LiveTranscriber(
  private val ctx: Context,
  private val meetingId: String,
  private val audioPath: String,
) {
  companion object {
    private const val TAG = "LiveTranscriber"

    /**
     * Feed the VAD in ten-second bites: big enough to amortise the JNI call, and comfortably
     * under the twelve-second lookahead chunk finality needs, so finality is never what waits.
     */
    private const val FEED_MS = 10_000L
    private const val IDLE_SLEEP_MS = 1_000L
    private const val BACKOFF_SLEEP_MS = 5_000L

    /** Sentinel for "capture is over": every remaining window is final. */
    private const val CAPTURE_ENDED_MS = Long.MAX_VALUE / 2

    /**
     * How many windows the drain after capture may decode.
     *
     * ProcessingService starts the pipeline the moment capture ends, and ProcessingEngine reads
     * the cache ONCE when ASR begins — so a window cached after that read is ignored. On a phone
     * that kept up, the drain is the one or two windows the VAD only released at finish(), and
     * this bound never bites. On a phone that fell behind it is a large backlog, and decoding it
     * would race the pipeline through the same audio with a second whisper context resident: the
     * memory and CPU contention DiarBudget exists to prevent, in exchange for rows nothing reads.
     *
     * Two windows is a minute of audio, which covers the genuine tail and nothing more.
     */
    private const val MAX_DRAIN_WINDOWS = 2
  }

  @Volatile private var running = false
  private var worker: Thread? = null

  fun start() {
    if (running) return
    // The SAME expressions ProcessingEngine uses, deliberately. The cache key is the model's file
    // name, so if these two ever resolved differently every window would miss and nothing would
    // fail — it would just look as though the live pass never helped. ProcessingService builds
    // ProcessingEngine with "base"; that literal is the coupling, and it lives in both places.
    val asrFile = ModelCatalog.fileFor(ctx, ModelCatalog.asrIdForModel("base"))
    val vadFile = File(File(ctx.filesDir, "models"), "silero_vad.onnx")
    if (asrFile == null || !asrFile.exists() || !vadFile.exists()) {
      Log.i(TAG, "not starting: models not installed")
      return
    }
    val free = LiveBudget.availableBytes(ctx)
    if (!LiveBudget.mayStart(free)) {
      Log.i(TAG, "not starting: ${free / 1024 / 1024}MB free is not enough headroom")
      return
    }
    running = true
    worker = thread(name = "audionotes-live", priority = Thread.MIN_PRIORITY) {
      // Below the capture thread on purpose. If the scheduler ever has to choose, the microphone
      // wins: losing a window here costs a cache entry, losing audio costs the meeting.
      run(AudioDb.get(ctx), vadFile.absolutePath, asrFile.absolutePath, asrFile.name)
    }
  }

  /** Ends the loop. Does NOT block: every window it finished is already committed, row by row. */
  fun stop() {
    running = false
  }

  private fun run(db: AudioDb, vadModel: String, asrModel: String, modelKey: String) {
    var vad = 0L
    var asr = 0L
    val threads = LiveBudget.threadsFor(
      Runtime.getRuntime().availableProcessors().coerceAtMost(4),
    )
    val spans = ArrayList<Long>()
    var tailBytes = 0L
    var cached = 0

    try {
      // Before ANY native call. NativeBridge.ensureLoaded System.load()s the downloaded
      // libonnxruntime.so by absolute path and then libaudionotes.so, and this pass is the first
      // thing in the process to touch native code: it runs as the recording STARTS, long before
      // ProcessingEngine would have loaded it. Without this the handles fail with
      // UnsatisfiedLinkError on every meeting, silently, because the live pass swallows its own
      // failures by design. It throws if the runtime has not been downloaded yet, which the
      // catch below turns into "no live pass" rather than a lost recording.
      NativeBridge.ensureLoaded(ctx)
      vad = NativeBridge.nativeVadOpen(vadModel, RecordingService.SAMPLE_RATE)
      // Same inputs the pipeline gives the factory, so the live pass and the post-hoc pass
      // resolve to the same engine. Today that is always whisper, since v1 is English only.
      val qwen3Dir = ModelCatalog.qwen3DirFor(ctx)
      asr = NativeBridge.nativeAsrOpen(
        asrModel, "en", if (qwen3Dir.isDirectory) qwen3Dir.absolutePath else "",
      )
      if (vad == 0L || asr == 0L) {
        Log.w(TAG, "native handles unavailable (vad=$vad asr=$asr)")
        return
      }
      Log.i(TAG, "live pass started for $meetingId with $threads thread(s)")

      var backedOff = false
      while (running) {
        if (backOff()) {
          // Logged on the TRANSITION, not every poll. Without this a run that cached nothing
          // said only "cached 0 window(s)", and finding out why meant dumpsys on a phone that
          // had already cooled down. The thresholds come from one device; this line is how the
          // next one argues with them.
          if (!backedOff) {
            backedOff = true
            Log.i(TAG, "backing off: ${LiveBudget.describe(
              LiveBudget.availableBytes(ctx), LiveBudget.thermalStatus(ctx),
              LiveBudget.batteryPercent(ctx), LiveBudget.isCharging(ctx),
              ProcessingService.isProcessing,
            )}")
          }
          Thread.sleep(BACKOFF_SLEEP_MS)
          continue
        }
        if (backedOff) {
          backedOff = false
          Log.i(TAG, "resuming: thermal=${LiveBudget.thermalStatus(ctx)} " +
            "pipelineBusy=${ProcessingService.isProcessing}")
        }

        val grown = File(audioPath).length() - tailBytes
        if (grown < FEED_MS * RecordingService.BYTES_PER_MS) { Thread.sleep(IDLE_SLEEP_MS); continue }

        for (v in NativeBridge.nativeVadFeed(vad, audioPath, tailBytes, grown)) spans.add(v)
        tailBytes += grown
        cached += decodeReadyWindows(db, asr, vad, spans, tailBytes / RecordingService.BYTES_PER_MS,
                                     modelKey, threads, stopping = false)
      }

      // Capture is over. Drain the tail of the file, close the VAD so a span still open is
      // released, then decode everything that is now final.
      val size = File(audioPath).length()
      if (size > tailBytes) {
        for (v in NativeBridge.nativeVadFeed(vad, audioPath, tailBytes, size - tailBytes)) spans.add(v)
        tailBytes = size
      }
      for (v in NativeBridge.nativeVadFinish(vad)) spans.add(v)
      cached += decodeReadyWindows(db, asr, vad, spans, CAPTURE_ENDED_MS, modelKey, threads,
                                   stopping = true, limit = MAX_DRAIN_WINDOWS)
      Log.i(TAG, "cached $cached window(s) for $meetingId")
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
    } catch (e: Throwable) {
      // Never fatal, and Throwable rather than Exception: an OutOfMemoryError here must cost the
      // cache and not the recording.
      Log.w(TAG, "live pass ended early", e)
    } finally {
      if (asr != 0L) NativeBridge.nativeAsrClose(asr)
      if (vad != 0L) NativeBridge.nativeVadClose(vad)
      running = false
    }
  }

  /**
   * Decode every window that can no longer change and is not already stored. Returns how many.
   *
   * [stopping] is the drain after capture ended: it must do its work rather than checking the
   * running flag, which is already false by then. [limit] bounds that drain — see
   * MAX_DRAIN_WINDOWS for why finishing a large backlog there is worse than dropping it.
   */
  private fun decodeReadyWindows(
    db: AudioDb, asr: Long, vad: Long, spans: ArrayList<Long>, capturedMs: Long,
    modelKey: String, threads: Int, stopping: Boolean, limit: Int = Int.MAX_VALUE,
  ): Int {
    val pending = NativeBridge.nativeVadPendingSpanStartMs(vad)
    val chunks = NativeBridge.nativeLiveChunks(asr, spans.toLongArray(), pending, capturedMs)
    var n = 0
    var i = 0
    while (i + 1 < chunks.size) {
      if (!stopping && !running) break
      val startMs = chunks[i]
      val endMs = chunks[i + 1]
      i += 2
      if (db.hasCachedWindow(meetingId, startMs, endMs, modelKey)) continue
      if (n >= limit) {
        Log.i(TAG, "drain stopped at $limit window(s); the pipeline decodes the rest")
        break
      }
      if (backOff()) break
      val json = NativeBridge.nativeAsrDecodeWindow(
        asr, audioPath, RecordingService.SAMPLE_RATE, startMs, endMs, threads,
      )
      // "[]" is stored too: a window that genuinely decoded to nothing is a RESULT, and storing
      // it is what stops the loop retrying it on every pass for the rest of the meeting.
      db.putCachedWindow(meetingId, startMs, endMs, modelKey, json)
      n++
    }
    return n
  }

  private fun backOff(): Boolean = LiveBudget.shouldBackOff(
    LiveBudget.thermalStatus(ctx), LiveBudget.batteryPercent(ctx), LiveBudget.isCharging(ctx),
    ProcessingService.isProcessing,
  )
}
