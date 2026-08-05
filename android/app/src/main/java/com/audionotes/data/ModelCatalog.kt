package com.audionotes.data

import android.content.Context
import com.audionotes.BuildConfig
import java.io.File

/**
 * The set of on-device models AudioNotes knows how to fetch. Models download on first run
 * (not bundled) per the build plan — a 2.5 GB APK kills install conversion.
 *
 * Every sha256 below was computed from the exact bytes at the URL next to it (verified
 * 2026-08-03). They are a supply-chain gate, not a nicety: without them a hijacked mirror or a
 * truncated download would be loaded and executed as model weights on the user's device. A blank
 * hash means verification is SKIPPED with a warning, so never leave one blank at release.
 *
 * If you change a URL, re-hash it:
 *   curl -sL <url> | shasum -a 256
 *
 * Licences (the product's core promise is Apache-2.0 / MIT only):
 *   silero-vad    MIT           github.com/snakers4/silero-vad
 *   whisper base  MIT           ggerganov/whisper.cpp GGML conversions
 *   whisper small MIT           ditto
 *   diar-seg      MIT           sherpa-onnx conversion of pyannote/segmentation-3.0.
 *                               pyannote/segmentation-3.0 is MIT and its card states it "will
 *                               always remain open-source", so commercial use and redistribution
 *                               are fine. It IS gated on Hugging Face, but a download gate is
 *                               access control on HF's servers, not a term attached to the
 *                               weights — and we fetch the ungated csukuangfj conversion, so no
 *                               account or token is needed at first run. The one real obligation
 *                               is MIT attribution: the conversion repo carries no licence
 *                               metadata of its own, so WE must ship pyannote's notice in an
 *                               in-app attributions screen. That screen does not exist yet.
 *   diar-emb      Apache-2.0    3D-Speaker CAM++ (Alibaba), bilingual zh+en.
 *                               TRAINING-DATA CAVEAT — ACCEPTED AS KNOWN DEBT, 2026-08-04.
 *                               Trained on VoxCeleb + CNCeleb + 3D-Speaker. VoxCeleb's own terms
 *                               are self-contradictory: Oxford VGG distributes it "for research
 *                               purposes" under CC-BY-4.0, while mirrors state academic /
 *                               non-commercial only. Whether model weights inherit a training
 *                               set's terms is unsettled law. The model CODE (3D-Speaker) is
 *                               Apache-2.0 and clean; only the data provenance is in question.
 *
 *                               Every English-capable embedding model carries this — WeSpeaker,
 *                               NeMo TitaNet and all 3D-Speaker English variants are VoxCeleb-
 *                               trained. The Mandarin-only model this replaced was the sole
 *                               VoxCeleb-free option, and using it in an English-first product
 *                               was the worse trade.
 *
 *                               Decision: ship it. The exposure is private licensing, not
 *                               regulatory, and the realistic surface is IP diligence or an
 *                               enterprise customer asking for a model bill-of-materials — which
 *                               can happen while we still own the product, not only on a sale.
 *                               Revisit if that comes up. Reverting is this one ModelSpec: no
 *                               code depends on which embedding model is used.
 *   llm-qwen      Apache-2.0    Qwen2.5-1.5B-Instruct
 */
/**
 * @param purpose  What this model DOES, in the user's words. This is the headline in Settings;
 *                 `name` is demoted to a parenthetical. "Silero VAD" tells someone deciding
 *                 whether they can free up 60 MB precisely nothing.
 * @param detail   One line on why it is worth its size, or what is lost without it.
 * @param required Needed for a meeting to go from audio to minutes at all. The optional ones
 *                 (a bigger transcriber, the LLM) are upgrades, and saying so is what stops the
 *                 list reading as "1.4 GB of mystery files".
 * @param upstream Where the file originates. Used as-is when no CDN is configured, and as the
 *                 fallback when one is — see [ModelCatalog.sourcesFor].
 */
data class ModelSpec(
  val id: String,
  val name: String,
  val purpose: String,
  val detail: String,
  val kind: String, // vad | asr | diar | llm
  val required: Boolean,
  val filename: String,
  val upstream: String,
  val sha256: String,
  val sizeBytes: Long,
)

object ModelCatalog {
  val ALL: List<ModelSpec> = listOf(
    ModelSpec(
      "silero-vad", "Silero VAD",
      "Finds the speech", "Skips the silence, so everything after it only works on real talking.",
      "vad", true, "silero_vad.onnx",
      "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
      "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3", 2_327_524L,
    ),
    ModelSpec(
      "whisper-base", "Whisper base",
      "Writes down what was said", "The standard transcriber — quick, and accurate enough for a normal meeting room.",
      "asr", true, "ggml-base-q5_1.bin",
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
      "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898", 59_707_625L,
    ),
    ModelSpec(
      "whisper-small", "Whisper small",
      "Writes down what was said, more accurately", "Three times the size and slower, but better with strong accents, crosstalk and poor audio.",
      "asr", false, "ggml-small-q5_1.bin",
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
      "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb", 190_085_487L,
    ),
    // Diarization: pyannote segmentation + a speaker-embedding model (both single .onnx).
    ModelSpec(
      "diar-seg", "pyannote segmentation 3.0",
      "Hears when the speaker changes", "Marks the moment one voice stops and another starts.",
      "diar", true, "diar_segmentation.onnx",
      "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx",
      "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079", 5_992_913L,
    ),
    // CAM++ bilingual (zh+en), replacing the Mandarin-only ERes2Net this app shipped first.
    // Measured on a Pixel 7 Pro over a 189s fixture (DiarEmbeddingBench), each in a fresh process:
    //
    //     CAM++ zh_en (this)                  44.0 s   0.23x realtime   27.0 MB
    //     WeSpeaker CAM++ en                  47.2 s   0.25x            29.3 MB
    //     ERes2Net zh-cn (previous)           87.7 s   0.46x            37.8 MB
    //     WeSpeaker ResNet34_LM en           104.1 s   0.55x            25.3 MB
    //
    // So this is 2x faster and 10.8 MB smaller than what it replaces, on top of covering the
    // language the product is actually for. All four scored identically (2 speakers, 100%
    // consistent) on a synthetic two-voice fixture, which is too easy a case to separate them —
    // the choice rests on cost and language coverage, NOT on measured diarization accuracy.
    ModelSpec(
      "diar-emb", "3D-Speaker CAM++",
      "Tells the voices apart", "Groups those turns into Speaker 1, Speaker 2, so you can name them.",
      "diar", true, "diar_embedding.onnx",
      "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
      "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2", 28_281_164L,
    ),
    // On-device LLM for minutes enhancement (Pro). Qwen family is Apache-2.0. Swap to a Qwen3
    // GGUF when you settle on one; Qwen2.5-1.5B-Instruct is a safe, widely available default.
    ModelSpec(
      "llm-qwen", "Qwen2.5 1.5B Instruct",
      "Writes the minutes in plain English", "Without it you still get minutes, pulled out by rules rather than written as prose.",
      "llm", false, "qwen-instruct-q4_k_m.gguf",
      "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e", 1_117_320_736L,
    ),
  )

  /** Everything a meeting needs to get from audio to minutes. Drives the first-run download. */
  val REQUIRED: List<ModelSpec> = ALL.filter { it.required }

  /**
   * Where to fetch a model from, in order of preference.
   *
   * The weights are NOT in the APK — an app that shipped 1.4 GB of them would lose most of its
   * installs at the Play Store size warning — so they are fetched once on first run. Until now
   * that meant fetching straight from GitHub and Hugging Face, which is fine for development and
   * not something to ship: those URLs are outside our control, can be rate-limited or moved, and
   * put first-run success at the mercy of a third party's uptime.
   *
   * Point `modelBaseUrl` at our own bucket (gradle.properties, or -PmodelBaseUrl= in CI) and it
   * is tried first, with upstream kept as a fallback so a CDN outage degrades to slow rather than
   * broken. Serving a mirror is safe because every file is sha256-verified after download against
   * the hash in this catalog — a substituted or corrupted file fails the same way from either
   * source. Leave it empty and behaviour is exactly as before.
   */
  fun sourcesFor(spec: ModelSpec): List<String> {
    val base = BuildConfig.MODEL_BASE_URL.trim().trimEnd('/')
    if (base.isEmpty()) return listOf(spec.upstream)
    return listOf("$base/models/v1/${spec.filename}", spec.upstream)
  }

  fun byId(id: String): ModelSpec? = ALL.firstOrNull { it.id == id }

  fun modelsDir(context: Context): File = File(context.filesDir, "models").apply { mkdirs() }

  fun fileFor(context: Context, id: String): File? =
    byId(id)?.let { File(modelsDir(context), it.filename) }

  /** ASR model id for the requested whisper size ("base" | "small"). */
  fun asrIdForModel(model: String): String = if (model == "small") "whisper-small" else "whisper-base"
}
