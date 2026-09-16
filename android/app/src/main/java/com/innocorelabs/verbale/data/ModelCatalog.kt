package com.innocorelabs.verbale.data

import android.content.Context
import com.innocorelabs.verbale.BuildConfig
import java.io.File

/**
 * The set of on-device models Verbale knows how to fetch. Models download on first run
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
 *   embed-bge-small  MIT        BAAI bge-small-en-v1.5 (text embeddings, 384-d, English). The
 *                               GGUF is CompendiumLabs' conversion; the hash below is the
 *                               Hugging Face LFS oid for the q8_0 file, read 2026-09-16.
 *   qwen3-asr     Apache-2.0    Qwen3-ASR-0.6B. The ONNX export is a third-party conversion
 *                               (github.com/Wasser1462/Qwen3-ASR-onnx, mirrored on ModelScope);
 *                               the weights it converts are Alibaba's under Apache-2.0. The
 *                               hashes below were computed from the bytes in the sherpa-onnx
 *                               release tarball, verified 2026-09-02.
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
/**
 * One downloadable file. Most models are a single part; Qwen3-ASR is six.
 *
 * Each part is fetched, sha256-verified and renamed into place on its own, exactly as a
 * single-file model always was — the multi-part case repeats that logic rather than replacing it,
 * which is deliberate: this is the path standing between a hijacked mirror and code executing on
 * a user's phone, and it was not worth redesigning to save a loop.
 *
 * `filename` may contain a subdirectory ("qwen3-asr/encoder.int8.onnx"). The download creates
 * parent directories; nothing else needs to know.
 */
data class ModelPart(
  val filename: String,
  val sha256: String,
  val sizeBytes: Long,
  /**
   * Where THIS file comes from, in full.
   *
   * Held per part rather than rebuilt from a shared base plus the filename, because the two are
   * not related: diar-seg is stored as `diar_segmentation.onnx` and served upstream as
   * `model.onnx`. A base-plus-filename scheme would have quietly produced a 404 for it.
   */
  val upstream: String,
)

data class ModelSpec(
  val id: String,
  val name: String,
  val purpose: String,
  val detail: String,
  val kind: String, // vad | asr | diar | llm
  val required: Boolean,
  val parts: List<ModelPart>,
  /**
   * Whether this model is shown to the user as something they can download.
   *
   * An unoffered model is not deleted: its catalogue row, its hashes and its place on the mirror
   * all stay, so it comes back by flipping one flag. What it must not do is sit in the list asking
   * somebody to fetch weights that nothing can currently select.
   */
  val offered: Boolean = true,
) {
  /** Total download, which is what the user is deciding about. */
  val sizeBytes: Long get() = parts.sumOf { it.sizeBytes }

  /** The single part, for the many places that still only ever deal with one. */
  val filename: String get() = parts.first().filename
}

/**
 * Single-file model — the shape every entry had before Qwen3-ASR arrived, kept so those entries
 * read exactly as they did and a one-file model never has to think about parts.
 */
fun ModelSpec(
  id: String, name: String, purpose: String, detail: String, kind: String, required: Boolean,
  filename: String, upstream: String, sha256: String, sizeBytes: Long,
): ModelSpec = ModelSpec(
  id, name, purpose, detail, kind, required,
  parts = listOf(ModelPart(filename, sha256, sizeBytes, upstream)),
  offered = true,
)

object ModelCatalog {
  val ALL: List<ModelSpec> = listOf(
    // The ONNX Runtime shared library is not a model, but it rides the same checksum-verified
    // download path: at 17 MB it was the biggest single thing in the APK, so it is kept out
    // (app/build.gradle packaging excludes) and fetched on first run. NativeBridge.ensureLoaded()
    // System.load()s it from filesDir before libaudionotes.so. required=true so first run cannot
    // finish without it — nothing native can load otherwise.
    ModelSpec(
      "onnxruntime-lib", "ONNX Runtime",
      "Runs the speech models", "The shared inference engine every speech model runs on. Kept out of the app download so the install stays small.",
      "runtime", true, "libonnxruntime.so",
      "https://github.com/akshayprodigy/AudioNotes/releases/download/runtime-v1.20.0/libonnxruntime-1.20.0-arm64-v8a.so",
      "52329b7c8e5fcd5c1aa88b01093215faaef362e3f3d0e374cb8b10d1e4704677", 17_571_160L,
    ),
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
    // Qwen3-ASR 0.6B, int8 — the Hindi transcriber, and the reason the ASR layer has two engines.
    //
    // Measured on a real Hindi/English meeting (2026-08-19), against whisper-base on the same
    // audio and the same VAD spans: 69.8% Devanagari against 4.1%, 1,205 words against 976, and
    // the Urdu-script junk that made those transcripts unreadable down from 18.0% to 6.6%.
    //
    // SIX FILES, one model. sherpa-onnx needs the conv frontend, encoder, decoder and a tokenizer
    // directory, and Qwen3Asr resolves them by convention from the parent directory — so the
    // filenames below are load-bearing and must not be "tidied".
    //
    // Not shipped as one archive on purpose: bz2 takes 987 MB to 878 MB, an 11% saving, in
    // exchange for needing the archive AND its contents on disk at once — 1.9 GB peak on a phone
    // for a 972 MB model. Six resumable files never exceed the model's own size, and a dropped
    // connection costs one file rather than the lot.
    //
    // required=false and behind the subscription: it is an optional "Hindi and English" download,
    // and at 972 MB it is the largest thing this app will ever ask for.
    //
    // offered=false since 2026-09-04. Nothing can select it: the engine routing table sends only
    // Hindi to Qwen, and Hindi is not an offered language while it has script evidence but no
    // accuracy number. Asking somebody to download 972 MB that cannot run is worse than not
    // mentioning it. The row, the hashes and the mirror all stay — this returns with Hindi.
    ModelSpec(
      "qwen3-asr", "Qwen3-ASR",
      "Writes down Hindi properly",
      "Hears Hindi and Hinglish the way they are actually spoken, in Devanagari rather than the garbled script the standard transcriber falls back to. A large download, and only worth it if you record in Hindi.",
      "asr", false,
      parts = listOf(
        ModelPart("qwen3-asr/conv_frontend.onnx",
          "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e", 44_148_281L,
          "https://modelscope.cn/models/zengshuishui/Qwen3-ASR-onnx/resolve/master/model_0.6B/conv_frontend.onnx"),
        ModelPart("qwen3-asr/encoder.int8.onnx",
          "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9", 182_491_662L,
          "https://modelscope.cn/models/zengshuishui/Qwen3-ASR-onnx/resolve/master/model_0.6B/encoder.int8.onnx"),
        ModelPart("qwen3-asr/decoder.int8.onnx",
          "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771", 755_914_231L,
          "https://modelscope.cn/models/zengshuishui/Qwen3-ASR-onnx/resolve/master/model_0.6B/decoder.int8.onnx"),
        ModelPart("qwen3-asr/tokenizer/vocab.json",
          "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910", 2_776_833L,
          "https://modelscope.cn/models/zengshuishui/Qwen3-ASR-onnx/resolve/master/tokenizer/vocab.json"),
        ModelPart("qwen3-asr/tokenizer/merges.txt",
          "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5", 1_671_853L,
          "https://modelscope.cn/models/zengshuishui/Qwen3-ASR-onnx/resolve/master/tokenizer/merges.txt"),
        ModelPart("qwen3-asr/tokenizer/tokenizer_config.json",
          "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c", 12_487L,
          "https://modelscope.cn/models/zengshuishui/Qwen3-ASR-onnx/resolve/master/tokenizer/tokenizer_config.json"),
      ),
      offered = false,
    ),
    // On-device LLM: writes the summary, the MOM narrative and the library one-liner (Narrator).
    // Qwen family is Apache-2.0. Swap to a Qwen3 GGUF when you settle on one; Qwen2.5-1.5B-Instruct
    // is a safe, widely available default.
    //
    // required=false is deliberate and is NOT the same as optional-in-practice: onboarding offers
    // it switched ON, so most installs will have it (it filters this list by kind, rather than
    // naming ids, so there is no second copy of "which models are offered" to drift). What the
    // flag buys is that a declined or failed 1.1 GB download leaves a working app rather than a
    // dead one — recording, transcription and rule-based minutes all function without it.
    ModelSpec(
      "llm-qwen", "Qwen2.5 1.5B Instruct",
      "Writes the minutes in plain English", "Without it you still get minutes, pulled out by rules rather than written as prose.",
      "llm", false, "qwen-instruct-q4_k_m.gguf",
      "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e", 1_117_320_736L,
    ),
    // The embedding model behind meaning search and Ask. BAAI bge-small-en-v1.5 (MIT), 33 M
    // parameters, 384 dimensions, English — the launch language. q8_0 from CompendiumLabs' GGUF
    // conversion; runs through the same llama.cpp as the writer (EmbedEngine).
    //
    // kind = "llm" on purpose, though it writes nothing: everything that gates, offers and
    // downloads "the writer" keys on that kind — needsSubscription, the onboarding switch, the
    // trial's download loop — and this model is useless without the writer and vice versa. One
    // bundle, one rule, no second list to drift. Narrator still asks for "llm-qwen" by id.
    ModelSpec(
      "embed-bge-small", "Meaning index",
      "Finds what was meant, not only the words said", "Without it search matches words only, and a meeting cannot be asked.",
      "llm", false, "bge-small-en-v1.5-q8_0.gguf",
      "https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q8_0.gguf",
      "ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514", 36_806_944L,
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
  fun sourcesFor(part: ModelPart): List<String> {
    val base = BuildConfig.MODEL_BASE_URL.trim().trimEnd('/')
    if (base.isEmpty()) return listOf(part.upstream)
    return listOf("$base/models/v1/${part.filename}", part.upstream)
  }

  /**
   * Whether a model may only be downloaded by a subscriber.
   *
   * The LLM writes the summary and the narrated minutes, which is exactly what Pro is, and
   * Narrator already refuses to run without an active subscription. Gating the *download* as well
   * does two further things:
   *
   * It is the only real barrier there is. The entitlement flag is a boolean in a database on a
   * phone its owner controls, and anyone willing to patch it has Pro; 1.1 GB of weights they have
   * to source themselves is a different proposition. Serving those weights only to subscribers is
   * what makes the boolean worth checking.
   *
   * And it stops taking a gigabyte of a free user's storage — and our bandwidth — for a file
   * nothing on their phone is ever allowed to load.
   *
   * Deliberately keyed on `kind`, not on an id: a second LLM added to the catalog is behind the
   * subscription by default, which is the safe direction for this to be wrong in.
   */
  /**
   * Which models are part of Pro.
   *
   * `kind == "llm"` was the whole rule when the writer model was the only paid thing here.
   * whisper-small is the other one: a straight accuracy upgrade — better with accents, crosstalk
   * and a bad room — and the PRD always had it on the paid side.
   *
   * Keyed by id rather than by kind, because the free tier's floor is whisper-base and that floor
   * is a promise. Gating `kind == "asr"` would take the guaranteed path away with it.
   *
   * Mirrored by PRO_MODEL_IDS in src/billing/trial.ts, which decides what the UI SAYS. This is the
   * refusal that matters — it is what a patched JS bundle cannot reach.
   */
  fun needsSubscription(spec: ModelSpec): Boolean =
    spec.kind == "llm" || spec.id == "whisper-small" || spec.id == "qwen3-asr"

  fun byId(id: String): ModelSpec? = ALL.firstOrNull { it.id == id }

  fun modelsDir(context: Context): File = File(context.filesDir, "models").apply { mkdirs() }

  fun fileFor(context: Context, id: String): File? =
    byId(id)?.let { File(modelsDir(context), it.filename) }

  /**
   * Where a Qwen3-ASR export lives, installed or not.
   *
   * A DIRECTORY, not a file, because that engine needs four artifacts — conv_frontend.onnx,
   * encoder.onnx, decoder.onnx and tokenizer/ — and the core resolves them by convention from one
   * path, so a single string crosses JNI for either engine.
   *
   * It is deliberately NOT in ALL yet. Every entry there carries a sha256 computed from the exact
   * bytes at its URL, and this comment is not the place to invent four of them: a blank hash turns
   * the download path into an unverified one, which the notes at the top of this file call a
   * supply-chain gate rather than a nicety. Until the export is pinned and hashed, the model can
   * be side-loaded here and the engine will pick it up; nothing else needs to change.
   */
  fun qwen3DirFor(context: Context): File = File(modelsDir(context), "qwen3-asr")

  /** ASR model id for the requested whisper size ("base" | "small"). */
  fun asrIdForModel(model: String): String = if (model == "small") "whisper-small" else "whisper-base"
}
