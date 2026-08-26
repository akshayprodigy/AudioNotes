package com.audionotes.pipeline

import android.content.Context
import com.audionotes.data.ModelCatalog
import java.io.File

/**
 * JNI bridge into the shared C++ core (libaudionotes): VAD, ASR, diarization, rule-based minutes,
 * and the LLM plumbing that Narrator drives.
 */
object NativeBridge {
  @Volatile private var loaded = false

  /**
   * Load the native core. libonnxruntime.so is NOT packaged in the APK (kept out to keep the
   * install small — see ModelCatalog "onnxruntime-lib" and app/build.gradle packaging excludes);
   * ModelManager downloads it to filesDir/models on first run. It is System.load()ed by absolute
   * path FIRST so libaudionotes.so's DT_NEEDED on libonnxruntime.so, and the RTLD_GLOBAL dlopen in
   * util/ort_init.cpp, both resolve to this one loaded copy. Idempotent; every caller invokes it
   * before its first native call.
   */
  @Synchronized
  fun ensureLoaded(context: Context) {
    if (loaded) return
    val ort = File(ModelCatalog.modelsDir(context), "libonnxruntime.so")
    check(ort.exists()) {
      "libonnxruntime.so not downloaded yet — ModelManager must fetch \"onnxruntime-lib\" first"
    }
    // Loading executable code from a writable file draws a W^X warning ("will throw on a future
    // Android version") — clear the write bit first so the loaded .so is read-only.
    if (ort.canWrite()) ort.setReadOnly()
    System.load(ort.absolutePath)
    System.loadLibrary("audionotes")
    loaded = true
  }

  /**
   * Run Silero VAD over a PCM16 mono file. Returns a flat array of speech segments in ms:
   * [start0, end0, start1, end1, ...]. Empty if the whole file is silence.
   */
  external fun nativeVad(pcmPath: String, modelPath: String, sampleRate: Int): LongArray

  /**
   * Transcribe the given VAD speech spans of a PCM16 mono file with whisper.cpp.
   * segStarts/segEnds are parallel arrays (ms). Returns a JSON array string of
   * {start_ms, end_ms, text} utterances with timestamps re-anchored to the meeting timeline.
   */
  /** @param threads 0 = automatic (big.LITTLE-aware default); >0 pins the count, for benchmarks. */
  external fun nativeTranscribe(
    pcmPath: String,
    modelPath: String,
    sampleRate: Int,
    segStarts: LongArray,
    segEnds: LongArray,
    threads: Int = 0,
  ): String

  /**
   * Speaker diarization via sherpa-onnx. Returns flat triples [start_ms, end_ms, speaker, ...].
   * numSpeakers: 0 = auto (threshold clustering); >0 = fixed count.
   */
  external fun nativeDiarize(
    pcmPath: String,
    segModelPath: String,
    embModelPath: String,
    sampleRate: Int,
    numSpeakers: Int,
  ): LongArray

  // ---- LLM (llama.cpp). Handle-based: load once, generate many, then free. ----
  /**
   * @param greedy true pins argmax sampling. Minutes that differ between two runs of the same
   *   recording are not minutes, and the eval harness has always judged greedy output — so while
   *   this defaulted to sampling at temperature 0.3, every score it reported described something
   *   the user never saw.
   * @param repeatPenalty 1.0f disables it. Argmax alone degenerates into loops on repetitive input
   *   — measured emitting one transcript line forty times — and a penalty breaks the loop while
   *   staying reproducible, since it reshapes the distribution deterministically. Separate from
   *   [greedy] on purpose: the eval judge answers many claims per batch mostly with the same word,
   *   and penalising repeats there would push it off a correct verdict for no reason but having
   *   just given it. Narration passes 1.15f.
   */
  external fun nativeLlmLoad(
    modelPath: String,
    nCtx: Int,
    nThreads: Int,
    greedy: Boolean,
    repeatPenalty: Float,
  ): Long
  external fun nativeLlmGenerate(handle: Long, prompt: String, maxTokens: Int): String
  external fun nativeLlmFree(handle: Long)

  /**
   * Transcript split into prompt-sized chunks by the shared core (transcriptLines +
   * chunkTranscript). Same parallel-array shape as [nativeMinutes].
   */
  external fun nativeLlmChunks(
    texts: Array<String>,
    speakerIds: Array<String>,
    spkIds: Array<String>,
    spkNames: Array<String>,
  ): Array<String>

  // Prompt builders. Kotlin never composes prompt text itself — every word of every prompt lives
  // in cpp/minutes/llm_prompts.cpp, which is what the desktop CLI and the eval harness exercise.
  // A Kotlin copy would be the third after summarize.ts and llm_prompts.cpp, and the one nothing
  // holds in sync.
  external fun nativeLlmMapPrompt(chunk: String): String

  /**
   * Prose digest of one transcript chunk, and the merge of several digests into a shorter account.
   *
   * The narrative is NOT written from the DECISIONS/ACTIONS/QUESTIONS notes, though it was at
   * first: a 1.5B model mirrors the shape of its input, so fed those notes it answers with
   * "#### Actions:" and a bullet list however firmly the prompt forbids headings. Fed dialogue or
   * prose it writes prose. The rule extractor owns the list items, so nothing in the prose chain
   * needs the notes at all.
   */
  external fun nativeLlmDigestPrompt(chunk: String): String
  external fun nativeLlmCondensePrompt(prose: String): String

  external fun nativeLlmFoldPrompt(notes: String): String
  external fun nativeLlmNarrativePrompt(notes: String): String
  external fun nativeLlmSummaryPrompt(narrative: String): String
  external fun nativeLlmHeadlinePrompt(summary: String): String

  /**
   * Strip markdown markers from generated prose. The app renders these strings as plain text, and
   * the model writes "**Meeting Topic:**" under every prompt wording tried, so the reader would
   * otherwise see the asterisks. One definition, shared with the CLI, rather than a Kotlin copy.
   */
  external fun nativeStripMarkdown(text: String): String

  /**
   * Which notes to merge so they fit one prompt. Flat [groupIndex, noteIndex, ...] pairs; empty
   * when the notes already fit.
   */
  external fun nativeLlmFoldPlan(notes: Array<String>, maxChars: Int): IntArray

  /**
   * Rule-based minutes from the shared core — the same code path `src/pipeline/minutes.ts` and the
   * desktop CLI run, golden-tested against the real TS. Replaces the hand-maintained Kotlin
   * MinutesExtractor, which was a third copy of these rules with nothing keeping it in sync.
   *
   * Parallel arrays rather than JSON, matching nativeVad/nativeDiarize: texts[i] pairs with
   * speakerIds[i] ("" when unassigned), and spkIds[i] with spkNames[i].
   *
   * Returns a flat array of [kind, content, source] triples.
   */
  external fun nativeMinutes(
    texts: Array<String>,
    speakerIds: Array<String>,
    spkIds: Array<String>,
    spkNames: Array<String>,
  ): Array<String>
}
