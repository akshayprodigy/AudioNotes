package com.audionotes

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.audionotes.data.AudioDb
import com.audionotes.data.ModelCatalog
import com.audionotes.pipeline.NativeBridge
import com.audionotes.pipeline.Narrator
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Exercises the C++ core (libaudionotes) directly on a device — no UI, no Metro, no reliance on
 * the logcat ring buffer, which rotates far too fast to debug a long pipeline run against.
 *
 * Run with:  ./gradlew connectedDebugAndroidTest
 *
 * Fixture: `jfk.pcm` in androidTest/assets — 16 kHz mono PCM16 of a known sentence, padded with
 * silence, so both halves of VAD (finds speech / strips silence) and the ASR text are checkable.
 *
 * Model files are NOT bundled (they are 57 MB+). The test reads whatever ModelManager has already
 * installed in the app's filesDir and skips itself via assumeTrue when a model is absent, so a
 * clean device reports "skipped" rather than a misleading failure.
 */
@RunWith(AndroidJUnit4::class)
class NativePipelineTest {

  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

  /**
   * Load libaudionotes before any external fun is touched.
   *
   * NativeBridge used to self-load in an `init { System.loadLibrary("audionotes") }` block, so
   * these tests never had to. `2cbc1a2` moved libonnxruntime.so out of the APK to a first-run
   * download, which means it must now be System.load()ed by absolute path FIRST — so the static
   * init became the explicit ensureLoaded(context) below, and this file was never updated. Every
   * native test here threw UnsatisfiedLinkError as a result; it went unnoticed because the
   * androidTest source set stopped compiling around the same time (see CaptureStateTest).
   */
  @Before
  fun loadCore() {
    val ort = File(ModelCatalog.modelsDir(ctx), "libonnxruntime.so")
    assumeTrue("libonnxruntime.so not downloaded yet on this device", ort.exists())
    NativeBridge.ensureLoaded(ctx)
  }

  /** Copy the packed fixture out of androidTest assets into a real file the C++ side can fopen. */
  private fun fixturePcm(): File {
    val out = File(ctx.cacheDir, "jfk.pcm")
    if (!out.exists() || out.length() == 0L) {
      InstrumentationRegistry.getInstrumentation().context.assets.open("jfk.pcm").use { input ->
        out.outputStream().use { input.copyTo(it) }
      }
    }
    return out
  }

  private fun vadModel(): File? =
    File(ModelCatalog.modelsDir(ctx), "silero_vad.onnx").takeIf { it.exists() }

  private fun whisperModel(): File? =
    ModelCatalog.fileFor(ctx, "whisper-base")?.takeIf { it.exists() }

  @Test
  fun vad_finds_speech_and_strips_silence() {
    val model = vadModel()
    assumeTrue("silero_vad.onnx not installed on this device", model != null)

    val pcm = fixturePcm()
    val totalMs = pcm.length() / 32 // 16 kHz * 2 bytes = 32 bytes/ms
    val flat = NativeBridge.nativeVad(pcm.absolutePath, model!!.absolutePath, 16000)

    val segments = flat.size / 2
    val speechMs = (0 until segments).sumOf { flat[it * 2 + 1] - flat[it * 2] }
    println("VAD: ${totalMs}ms audio -> $segments segment(s), ${speechMs}ms speech")

    // The regression this guards: Silero v5 needs 64 samples of context prepended to each
    // 512-sample frame. Feeding a bare 512 does not error, it just returns ~0 probability
    // everywhere, which surfaces as "0 segments" on audio that plainly contains speech.
    assertTrue("VAD found no speech in a file that is mostly speech", segments > 0)
    assertTrue("VAD should strip the padded silence", speechMs < totalMs)
    assertTrue("VAD dropped almost all of the speech", speechMs > totalMs / 4)
  }

  @Test
  fun whisper_transcribes_the_known_sentence() {
    val vad = vadModel()
    val asr = whisperModel()
    assumeTrue("silero_vad.onnx not installed", vad != null)
    assumeTrue("whisper base model not installed", asr != null)

    val pcm = fixturePcm()
    val flat = NativeBridge.nativeVad(pcm.absolutePath, vad!!.absolutePath, 16000)
    assumeTrue("VAD produced no spans to transcribe", flat.isNotEmpty())

    val n = flat.size / 2
    val starts = LongArray(n) { flat[it * 2] }
    val ends = LongArray(n) { flat[it * 2 + 1] }

    val started = System.currentTimeMillis()
    val json = NativeBridge.nativeTranscribe(pcm.absolutePath, asr!!.absolutePath, 16000, starts, ends)
    val elapsed = System.currentTimeMillis() - started

    val arr = JSONArray(json)
    val text = buildString {
      for (i in 0 until arr.length()) append(arr.getJSONObject(i).optString("text")).append(' ')
    }.lowercase()
    println("ASR: ${arr.length()} utterance(s) in ${elapsed}ms -> \"${text.trim()}\"")

    assertTrue("whisper returned no utterances", arr.length() > 0)
    // The fixture is the JFK line; "country" is the least ambiguous word in it.
    assertTrue("transcript did not contain the expected words: $text", text.contains("country"))
  }

  /**
   * First execution of the diarization path, and the real point of this test is not accuracy —
   * it is that sherpa-onnx and the Silero VAD share ONE ONNX Runtime without blowing up.
   *
   * Silero resolves ORT lazily via dlopen with ORT_API_MANUAL_INIT, while sherpa links
   * libonnxruntime.so at load time. Both end up touching the same Ort::Global api pointer, so if
   * that arrangement is wrong it fails here (or crashes the process) rather than in front of a
   * user. Running VAD first is deliberate: it forces the manual-init path to happen before
   * sherpa's first call.
   *
   * Speaker COUNT *is* asserted now, and it is no longer a tuning question. sherpa's default
   * merge threshold of 0.5 shipped for months and was measured splitting 4-speaker AMI meetings
   * into 28-101 clusters — attribution no better than assigning the whole meeting to one person.
   * The default is 1.0 as of the sweep in docs/superpowers/eval-baseline-whisper-base.md.
   *
   * A single-speaker fixture is the cheapest possible guard on that: one voice must not fragment.
   * Revert the threshold and this fails, which is the whole point of writing it down here rather
   * than only in a desktop harness the app build never runs.
   */
  @Test
  fun diarization_runs_and_shares_the_onnx_runtime_with_vad() {
    val vad = vadModel()
    val seg = ModelCatalog.fileFor(ctx, "diar-seg")?.takeIf { it.exists() }
    val emb = ModelCatalog.fileFor(ctx, "diar-emb")?.takeIf { it.exists() }
    assumeTrue("silero_vad.onnx not installed", vad != null)
    assumeTrue("diarization models not installed", seg != null && emb != null)

    val pcm = fixturePcm()
    val totalMs = pcm.length() / 32

    // Touch the dlopen/manual-init path first, then hand ORT to sherpa.
    NativeBridge.nativeVad(pcm.absolutePath, vad!!.absolutePath, 16000)

    val started = System.currentTimeMillis()
    val tri = NativeBridge.nativeDiarize(
      pcm.absolutePath, seg!!.absolutePath, emb!!.absolutePath, 16000, /*numSpeakers=*/0,
    )
    val elapsed = System.currentTimeMillis() - started

    val n = tri.size / 3
    val speakers = (0 until n).map { tri[it * 3 + 2] }.toSortedSet()
    println("DIAR: $n segment(s), ${speakers.size} speaker(s), ${elapsed}ms for ${totalMs}ms audio")

    assertTrue("diarization returned no segments for audio containing speech", n > 0)
    // One person speaking must not come back as a crowd. Generous by design — the gate is
    // "fragmentation", not an exact count, because segmentation may legitimately split a pause.
    assertTrue(
      "one speaker fragmented into ${speakers.size} clusters — the diarization merge threshold " +
        "has regressed (should be 1.0, see Diarizer::Diarizer)",
      speakers.size <= 2,
    )
    for (i in 0 until n) {
      val s = tri[i * 3]
      val e = tri[i * 3 + 1]
      assertTrue("segment $i has end before start ($s..$e)", e >= s)
      assertTrue("segment $i runs past the end of the audio ($e > $totalMs)", e <= totalMs + 2000)
    }
  }

  /**
   * First execution of the on-device LLM. Loads the Qwen GGUF once and generates against it,
   * mirroring how the map/reduce summariser drives it.
   *
   * Asserts only that generation produces text: summary QUALITY from a 1.5B model is exactly why
   * the rule-based minutes are the guaranteed floor and the LLM is best-effort enhancement.
   */
  @Test
  fun llm_loads_and_generates() {
    val gguf = ModelCatalog.fileFor(ctx, "llm-qwen")?.takeIf { it.exists() }
    assumeTrue("Qwen GGUF not installed", gguf != null)

    val loaded = System.currentTimeMillis()
    val handle =
      NativeBridge.nativeLlmLoad(
        gguf!!.absolutePath, /*nCtx=*/2048, /*nThreads=*/4, /*greedy=*/true, /*repeatPenalty=*/1.15f)
    val loadMs = System.currentTimeMillis() - loaded
    assertTrue("llama failed to load the model (handle=0)", handle != 0L)

    try {
      val started = System.currentTimeMillis()
      val out = NativeBridge.nativeLlmGenerate(
        handle,
        "Reply with exactly one short sentence: what is a meeting agenda for?",
        /*maxTokens=*/48,
      )
      val genMs = System.currentTimeMillis() - started
      println("LLM: loaded in ${loadMs}ms, generated ${out.length} chars in ${genMs}ms -> \"${out.trim()}\"")
      assertTrue("llama returned no text", out.isNotBlank())
    } finally {
      NativeBridge.nativeLlmFree(handle)
    }
  }

  @Test
  fun transcript_timestamps_stay_on_the_meeting_timeline() {
    val vad = vadModel()
    val asr = whisperModel()
    assumeTrue("models not installed", vad != null && asr != null)

    val pcm = fixturePcm()
    val totalMs = pcm.length() / 32
    val flat = NativeBridge.nativeVad(pcm.absolutePath, vad!!.absolutePath, 16000)
    assumeTrue("no spans", flat.isNotEmpty())
    val n = flat.size / 2
    val json = NativeBridge.nativeTranscribe(
      pcm.absolutePath, asr!!.absolutePath, 16000,
      LongArray(n) { flat[it * 2] }, LongArray(n) { flat[it * 2 + 1] },
    )

    // whisper reports timestamps relative to each chunk; they must be re-anchored to the global
    // meeting timeline or the transcript drifts badly on long meetings.
    val arr = JSONArray(json)
    for (i in 0 until arr.length()) {
      val o = arr.getJSONObject(i)
      val s = o.getLong("start_ms")
      val e = o.getLong("end_ms")
      assertTrue("utterance $i starts before zero: $s", s >= 0)
      assertTrue("utterance $i ends past the end of the audio ($e > $totalMs)", e <= totalMs + 2000)
      assertTrue("utterance $i has end before start", e >= s)
    }
  }

  // ---- Narration (Narrator + the LLM plumbing) ----

  /** Five lines of a plausible meeting: one decision, one owner, one unanswered question. */
  private fun seedTranscript(db: AudioDb, id: String) {
    val lines = listOf(
      "We need to decide the vendor code format before Friday.",
      "The current codes are eight characters and SAP truncates them to six.",
      "Ana will draft the mapping table and send it round.",
      "Do we migrate the existing codes or only the new ones?",
      "Let us agree the format first, then decide about migration.",
    )
    val arr = JSONArray()
    lines.forEachIndexed { i, t ->
      arr.put(
        org.json.JSONObject()
          .put("start_ms", i * 5000L)
          .put("end_ms", i * 5000L + 4000L)
          .put("text", t),
      )
    }
    db.replaceUtterancesJson(id, arr.toString())
  }

  private fun newMeeting(db: AudioDb, tag: String): String {
    val id = "$tag-" + java.util.UUID.randomUUID()
    db.insertMeeting(id, "narration test", System.currentTimeMillis(), "free", "/dev/null")
    return id
  }

  /**
   * Narration end to end, and the measurement the design spec left open: prefill on a long prompt.
   *
   * The spec recorded model load at 2,427 ms and decode at ~10 tok/s but marked prefill "not
   * measured", which is the term that decides whether a short meeting costs 15 s or 40 s.
   */
  @Test
  fun narration_writes_a_summary_a_narrative_and_a_headline() {
    val gguf = ModelCatalog.fileFor(ctx, "llm-qwen")?.takeIf { it.exists() }
    assumeTrue("Qwen GGUF not installed", gguf != null)

    val db = AudioDb.get(ctx)
    val id = newMeeting(db, "narrate")
    try {
      seedTranscript(db, id)

      val stages = ArrayList<String>()
      val started = System.currentTimeMillis()
      val narrated = Narrator.run(ctx, id, object : Narrator.Progress {
        override fun onStage(stage: String, done: Int, total: Int) {
          stages.add("$stage $done/$total")
        }
        override fun isCancelled() = false
      })
      val elapsed = System.currentTimeMillis() - started
      println("NARRATE: ok=$narrated in ${elapsed}ms, progress=$stages")
      assertTrue("narration produced nothing", narrated)

      val llm = db.minutesBySource(id, "llm")
      val summary = llm.firstOrNull { it.kind == "summary" }
      val narrative = llm.firstOrNull { it.kind == "narrative" }
      println("NARRATE summary: ${summary?.content}")
      println("NARRATE headline: ${db.summaryLine(id)}")
      assertTrue("no summary row", summary != null && summary.content.isNotBlank())
      assertTrue("no narrative row", narrative != null && narrative.content.isNotBlank())
      assertTrue("no headline on the meeting row", !db.summaryLine(id).isNullOrBlank())

      // The app renders these as plain text, so a stray asterisk is shown to the reader literally.
      for (m in llm) {
        assertFalse("markdown survived into ${m.kind}: ${m.content}", m.content.contains("**"))
        assertFalse("markdown survived into ${m.kind}: ${m.content}", m.content.contains("##"))
      }

      // Single chunk: no digests, so nothing should be checkpointed, and the chain is 3 steps.
      assertTrue("notes should be empty after a successful run", db.notes(id).isEmpty())

      // ---- prefill: same 32-token generation, ~1700-token prompt vs a 10-token one ----
      val handle = NativeBridge.nativeLlmLoad(
        gguf!!.absolutePath, 8192, 4, /*greedy=*/true, /*repeatPenalty=*/1.15f,
      )
      try {
        val long = "Summarise this meeting.\n" +
          List(60) { "The vendor code format was discussed at length by the group. " }.joinToString("")
        val t1 = System.currentTimeMillis()
        NativeBridge.nativeLlmGenerate(handle, "Say hello.", 32)
        val shortMs = System.currentTimeMillis() - t1
        val t2 = System.currentTimeMillis()
        NativeBridge.nativeLlmGenerate(handle, long, 32)
        val longMs = System.currentTimeMillis() - t2
        println("PREFILL: short=${shortMs}ms long=${longMs}ms delta=${longMs - shortMs}ms " +
          "promptChars=${long.length}")
      } finally {
        NativeBridge.nativeLlmFree(handle)
      }
    } finally {
      db.deleteMeeting(id)
    }
  }

  /**
   * A digest already committed for a chunk is never regenerated.
   *
   * Seeded with a sentinel no model would produce from this transcript, so the assertion cannot
   * pass by coincidence — without it, a checkpoint that is written and then ignored looks exactly
   * like one that works.
   */
  @Test
  fun narration_resumes_from_committed_digests() {
    val gguf = ModelCatalog.fileFor(ctx, "llm-qwen")?.takeIf { it.exists() }
    assumeTrue("Qwen GGUF not installed", gguf != null)

    val db = AudioDb.get(ctx)
    val id = newMeeting(db, "resume")
    try {
      // Two chunks: chunkTranscript splits at 6000 chars, so two 4000-char lines cannot share one.
      val arr = JSONArray()
      listOf("a", "b").forEachIndexed { i, ch ->
        arr.put(
          org.json.JSONObject()
            .put("start_ms", i * 5000L)
            .put("end_ms", i * 5000L + 4000L)
            .put("text", "The team discussed the plan. " + ch.repeat(4000)),
        )
      }
      db.replaceUtterancesJson(id, arr.toString())

      val chunks = NativeBridge.nativeLlmChunks(
        arrayOf("x"), arrayOf(""), arrayOf(), arrayOf(),
      )
      assertTrue("sanity: chunking works", chunks.isNotEmpty())

      val sentinel = "The group settled the ZZSENTINELZZ protocol and moved on."
      db.putNote(id, 0, sentinel)
      assertEquals(sentinel, db.notes(id)[0])

      val narrated = Narrator.run(ctx, id, object : Narrator.Progress {
        override fun onStage(stage: String, done: Int, total: Int) {}
        override fun isCancelled() = false
      })
      assertTrue("narration produced nothing", narrated)

      // The sentinel must have reached the narrative. The transcript never mentions it, so its
      // presence proves chunk 0 came from the checkpoint rather than being regenerated.
      val narrative = db.minutesBySource(id, "llm").first { it.kind == "narrative" }.content
      println("RESUME narrative: $narrative")
      assertTrue(
        "chunk 0 was regenerated instead of resumed — the committed digest never reached the model",
        narrative.contains("ZZSENTINELZZ", ignoreCase = true),
      )
      assertTrue("the checkpoint should be cleared after success", db.notes(id).isEmpty())
    } finally {
      db.deleteMeeting(id)
    }
  }
}
