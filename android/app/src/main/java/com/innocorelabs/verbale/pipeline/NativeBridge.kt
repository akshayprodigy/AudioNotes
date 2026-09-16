package com.innocorelabs.verbale.pipeline

import android.content.Context
import com.innocorelabs.verbale.data.ModelCatalog
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
   * Streaming VAD, for running while a recording is still being written.
   *
   * [nativeVadFeed] consumes a byte range of the PCM file and returns the spans that range
   * RELEASED, flat as [start0, end0, ...] — usually none. Bytes that do not complete a
   * 512-sample frame are retained, so feeding a file in pieces gives exactly what feeding it
   * whole gives; that is verified against real audio down to a 1023-byte bite.
   *
   * [nativeVadPendingSpanStartMs] reports the earliest span the VAD knows about but has not
   * handed back — one it is still inside, or one it is holding to see whether padding merges it
   * into the next. Chunk finality needs it: both kinds can still join the previous decode window
   * and neither is visible in what feed() returned. -1 when there is none.
   *
   * A handle of 0 means the model would not open. That is not fatal: the live pass is an
   * optimisation and the meeting is transcribed afterwards exactly as it always was.
   */
  external fun nativeVadOpen(modelPath: String, sampleRate: Int): Long
  external fun nativeVadFeed(handle: Long, pcmPath: String, fromByte: Long, byteCount: Long): LongArray
  external fun nativeVadFinish(handle: Long): LongArray
  external fun nativeVadPendingSpanStartMs(handle: Long): Long
  external fun nativeVadClose(handle: Long)

  /**
   * A whisper context that stays loaded across windows.
   *
   * [nativeTranscribe] builds a fresh engine per call, so it re-reads the weights from disk every
   * time — fine once per meeting, impossible once per 30-second window.
   *
   * [nativeAsrDecodeWindow] returns `[{"t0":ms,"t1":ms,"text":"..."}]` with timestamps RELATIVE
   * to the window, which is what makes the result cacheable: it depends on the window's audio and
   * nothing about where the window sits in the meeting.
   *
   * The handle comes from the FACTORY, so the language picks the engine here exactly as it does
   * for [nativeTranscribe]. An engine that cannot decode a window in isolation returns nothing
   * and the live pass simply caches nothing for it.
   */
  external fun nativeAsrOpen(modelPath: String, language: String, qwen3ModelDir: String): Long
  external fun nativeAsrDecodeWindow(
    handle: Long, pcmPath: String, sampleRate: Int, startMs: Long, endMs: Long, threads: Int,
  ): String
  external fun nativeAsrClose(handle: Long)

  /**
   * Which decode windows can no longer change, given the spans released so far, the earliest
   * span still pending (or -1) and how much audio exists. Flat [start0, end0, ...].
   *
   * Takes the ASR handle so it uses THAT engine's window budget and packing mode. The chunking
   * rule lives in C++ with the post-hoc pass and is deliberately not reimplemented here: two
   * copies that drift would cost every cache hit and nothing would fail.
   */
  external fun nativeLiveChunks(
    asrHandle: Long, spansMs: LongArray, pendingSpanStartMs: Long, capturedMs: Long,
  ): LongArray

  /**
   * Transcribe the given VAD speech spans of a PCM16 mono file with whisper.cpp.
   * segStarts/segEnds are parallel arrays (ms). Returns a JSON array string of
   * {start_ms, end_ms, text} utterances with timestamps re-anchored to the meeting timeline.
   */
  /**
   * Called on the native thread between units of work — after each ASR window, each diarization
   * chunk. Return false to abort (ASR honours it before the next window; sherpa's diarizer
   * ignores it, so a diarize abort lands at the stage boundary). The callback may block: that is
   * how a thermal pause holds the pipeline without losing the unit in flight.
   */
  fun interface StageProgress { fun onProgress(done: Int, total: Int): Boolean }

  /**
   * @param threads 0 = automatic (big.LITTLE-aware default); >0 pins the count, for benchmarks.
   * @param language a whisper language code ("en", "hi", ...), or "auto"/"" to detect.
   *
   * Detection is per 30-second chunk, not per meeting, because whisper runs with no_context set.
   * On Hindi/English code-switched speech — the audio this product is actually for — that returns
   * one meeting in several languages and several SCRIPTS: a measured 39% of utterances came back
   * in Urdu script. So the default is "en", not "auto".
   *
   * @param qwen3ModelDir directory holding the Qwen3-ASR export, or "" when it is not installed.
   *
   * The language picks the ENGINE, not just the decoder hint: Hindi selects Qwen3-ASR when this
   * directory has the weights in it, because whisper cannot hear Hindi — it read one recording at
   * 891 words and 8.8% Devanagari where Qwen read 1,211 at 87.6%. When the directory is empty or
   * missing, the run falls back to whisper and says so in the log rather than failing.
   */
  external fun nativeTranscribe(
    pcmPath: String,
    modelPath: String,
    sampleRate: Int,
    segStarts: LongArray,
    segEnds: LongArray,
    threads: Int = 0,
    language: String = "en",
    qwen3ModelDir: String = "",
    forceLanguage: Boolean = false,
    // Windows the live capture pass already decoded: ranges flat as [start0, end0, ...] and one
    // JSON string per window. Whisper uses one only when the boundaries match EXACTLY, so a cache
    // built against different VAD spans costs a decode and never a wrong word.
    cachedRangesMs: LongArray = LongArray(0),
    cachedWindowsJson: Array<String> = emptyArray(),
    progress: StageProgress? = null,
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
    /**
     * VAD speech spans as flat [startMs, endMs, ...] — the same shape nativeVad returns, so the
     * result can be handed straight back.
     *
     * Only these are read and diarized; the returned segments are already translated back to the
     * recording's own timeline. Pass an empty array to diarize the whole file, which is what this
     * did before and is 346 MB of float samples for a 90-minute meeting.
     */
    speechSpansMs: LongArray,
    /**
     * How much speech to diarize at once, in milliseconds. Negative reads all the speech into one
     * buffer; 0 takes the native default, which is itself "all of it" (kDiarWindowMs is 0).
     *
     * The app always passes [DiarBudget.WHOLE_MEETING]. Windowing was built and measured and costs
     * 6 DER points, because each window is clustered on its own and the windows then have to work
     * out which of their speakers were the same people — see cpp/diar/span_map.h. Nothing here
     * ever passes [DiarBudget.SKIP]: that means "do not call this at all".
     */
    windowMs: Long,
    progress: StageProgress? = null,
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

  /**
   * Generation bounded by a GBNF [grammar]: the sampler masks every token the grammar does not
   * admit, so the answer IS a string the grammar accepts or "" (a grammar that failed to parse —
   * logged in the core, never thrown here: a classifier that cannot run costs a label).
   */
  external fun nativeLlmGenerateConstrained(handle: Long, prompt: String, maxTokens: Int, grammar: String): String

  // ---- The typed record (evidence Phase B). The window is the source line and the replies
  // after it, as parallel arrays: ordinals (0 = the source), speaker names, texts. ----

  /** The grammar the classifier answers through. */
  external fun nativeClassifyGrammar(): String

  /** The prompt: window and statement fenced as recorded speech, then the question. */
  external fun nativeClassifyPrompt(itemText: String, ordinals: IntArray, speakers: Array<String>, texts: Array<String>): String

  /**
   * Parse + validate an answer against the window. The validated record as JSON — the same shape
   * the grammar produces — or "" when the answer did not parse. Only verbatim survives: a name or
   * a date not found in a cited turn comes back blank with confidence low.
   */
  external fun nativeValidateRecord(json: String, ordinals: IntArray, speakers: Array<String>, texts: Array<String>): String
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
  // `record`, not `notes` — and this declaration is the one Narrator authors read. For a meeting
  // that fits one chunk, most of them, what goes in here is the dialogue itself, which is why
  // narrativePrompt fences its input (cpp/minutes/fence.h). The old name said the opposite.
  external fun nativeLlmNarrativePrompt(record: String): String
  external fun nativeLlmSummaryPrompt(narrative: String): String
  external fun nativeLlmHeadlinePrompt(summary: String): String

  /**
   * Strip markdown markers from generated prose. The app renders these strings as plain text, and
   * the model writes "**Meeting Topic:**" under every prompt wording tried, so the reader would
   * otherwise see the asterisks. One definition, shared with the CLI, rather than a Kotlin copy.
   */
  /**
   * Every language the transcriber can be pinned to, as a JSON array of {code,label}.
   *
   * Asked of the engine rather than listed in the UI, because a hand-maintained shortlist drifts
   * from what the model can actually do. Verbale ships in India, the US and Europe; the picker
   * used to offer three choices, which is how somebody ends up unable to select the language they
   * are about to speak.
   */
  external fun nativeSupportedLanguages(): String

  external fun nativeStripMarkdown(text: String): String

  external fun nativeTrimToSentence(text: String): String

  external fun nativeStripLabels(text: String): String

  external fun nativeDropAbsenceTail(text: String): String

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

  /**
   * Rule-based items WITH their provenance — the same rules as [nativeMinutes], plus the turn each
   * item came from, its start and end in the meeting timeline, and the character span of the
   * sentence inside that turn.
   *
   * [nativeMinutes] takes texts and speaker ids and no timestamps, so it cannot produce an anchor.
   * That is why this is a second entry point rather than a widened one: the callers of the old
   * shape do not have timings to give.
   *
   * ids/startsMs/endsMs/texts/speakerIds are parallel and must be the same length — one entry per
   * turn, in transcript order. speakerIds[i] is "" for an unassigned turn, matching [nativeMinutes]
   * (an Array<String> cannot carry a null). spkIds[i] pairs with spkNames[i].
   *
   * Returns JSON, not the parallel-array shape the rest of this bridge uses, because an item has a
   * VARIABLE number of sources — a sentence said twice is one item with two pieces of evidence.
   * Parallel arrays cannot carry that without a second array of per-item source counts and matching
   * index arithmetic on both sides. See the note above nativeItems in cpp/jni/audionotes_jni.cpp.
   *
   * The item text is carried in the payload and must never be reconstructed by slicing a turn with
   * charStart/charEnd: the offsets index the turn as recorded and the text comes from an
   * apostrophe-normalized copy of it. See [Minutes.Source].
   */
  external fun nativeItems(
    ids: Array<String>,
    startsMs: LongArray,
    endsMs: LongArray,
    texts: Array<String>,
    speakerIds: Array<String>,
    spkIds: Array<String>,
    spkNames: Array<String>,
  ): String
}
