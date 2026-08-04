package com.audionotes

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.audionotes.data.ModelCatalog
import com.audionotes.pipeline.NativeBridge
import org.json.JSONArray
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
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
   * Speaker COUNT is not asserted — the fixture is a single speaker and clustering thresholds are
   * a tuning question for real multi-party audio, not a correctness gate.
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
    val handle = NativeBridge.nativeLlmLoad(gguf!!.absolutePath, /*nCtx=*/2048, /*nThreads=*/4)
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
}
