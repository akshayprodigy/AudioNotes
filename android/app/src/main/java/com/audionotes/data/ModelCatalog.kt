package com.audionotes.data

import android.content.Context
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
 *                               UPSTREAM CAVEAT: the original pyannote checkpoint is gated on
 *                               Hugging Face and its terms are NOT the same as sherpa-onnx's
 *                               Apache-2.0. Confirm this specific redistribution before shipping.
 *   diar-emb      Apache-2.0    3D-Speaker ERes2Net (Alibaba DAMO)
 *   llm-qwen      Apache-2.0    Qwen2.5-1.5B-Instruct
 */
data class ModelSpec(
  val id: String,
  val name: String,
  val kind: String, // vad | asr | llm
  val filename: String,
  val url: String,
  val sha256: String,
  val sizeBytes: Long,
)

object ModelCatalog {
  val ALL: List<ModelSpec> = listOf(
    ModelSpec(
      "silero-vad", "Silero VAD", "vad", "silero_vad.onnx",
      "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx",
      "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3", 2_327_524L,
    ),
    ModelSpec(
      "whisper-base", "Whisper base (q5_1)", "asr", "ggml-base-q5_1.bin",
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
      "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898", 59_707_625L,
    ),
    ModelSpec(
      "whisper-small", "Whisper small (q5_1)", "asr", "ggml-small-q5_1.bin",
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
      "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb", 190_085_487L,
    ),
    // Diarization: pyannote segmentation + a speaker-embedding model (both single .onnx).
    // VERIFY the pyannote-derived checkpoint's license individually before shipping.
    ModelSpec(
      "diar-seg", "Diarization: segmentation", "diar", "diar_segmentation.onnx",
      "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx",
      "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079", 5_992_913L,
    ),
    ModelSpec(
      "diar-emb", "Diarization: speaker embedding", "diar", "diar_embedding.onnx",
      "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
      "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b", 39_593_761L,
    ),
    // On-device LLM for minutes enhancement (Pro). Qwen family is Apache-2.0. Swap to a Qwen3
    // GGUF when you settle on one; Qwen2.5-1.5B-Instruct is a safe, widely available default.
    ModelSpec(
      "llm-qwen", "Qwen2.5 1.5B Instruct (Q4_K_M)", "llm", "qwen-instruct-q4_k_m.gguf",
      "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e", 1_117_320_736L,
    ),
  )

  fun byId(id: String): ModelSpec? = ALL.firstOrNull { it.id == id }

  fun modelsDir(context: Context): File = File(context.filesDir, "models").apply { mkdirs() }

  fun fileFor(context: Context, id: String): File? =
    byId(id)?.let { File(modelsDir(context), it.filename) }

  /** ASR model id for the requested whisper size ("base" | "small"). */
  fun asrIdForModel(model: String): String = if (model == "small") "whisper-small" else "whisper-base"
}
