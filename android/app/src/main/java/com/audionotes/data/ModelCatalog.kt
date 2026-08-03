package com.audionotes.data

import android.content.Context
import java.io.File

/**
 * The set of on-device models AudioNotes knows how to fetch. Models download on first run
 * (not bundled) per the build plan. sha256 may be blank during bring-up — when blank, download
 * verification is skipped (a warning is logged); fill these in before shipping.
 *
 * Whisper GGML models come from the whisper.cpp Hugging Face repo. If you prefer q5_0 over q5_1,
 * swap the filename/url accordingly.
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
      "", 2_327_524L,
    ),
    ModelSpec(
      "whisper-base", "Whisper base (q5_1)", "asr", "ggml-base-q5_1.bin",
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin",
      "", 57_000_000L,
    ),
    ModelSpec(
      "whisper-small", "Whisper small (q5_1)", "asr", "ggml-small-q5_1.bin",
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
      "", 190_000_000L,
    ),
    // Diarization: pyannote segmentation + a speaker-embedding model (both single .onnx).
    // VERIFY the pyannote-derived checkpoint's license individually before shipping.
    ModelSpec(
      "diar-seg", "Diarization: segmentation", "diar", "diar_segmentation.onnx",
      "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx",
      "", 5_900_000L,
    ),
    ModelSpec(
      "diar-emb", "Diarization: speaker embedding", "diar", "diar_embedding.onnx",
      "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
      "", 26_000_000L,
    ),
    // On-device LLM for minutes enhancement (Pro). Qwen family is Apache-2.0. Swap to a Qwen3
    // GGUF when you settle on one; Qwen2.5-1.5B-Instruct is a safe, widely available default.
    ModelSpec(
      "llm-qwen", "Qwen2.5 1.5B Instruct (Q4_K_M)", "llm", "qwen-instruct-q4_k_m.gguf",
      "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "", 1_120_000_000L,
    ),
  )

  fun byId(id: String): ModelSpec? = ALL.firstOrNull { it.id == id }

  fun modelsDir(context: Context): File = File(context.filesDir, "models").apply { mkdirs() }

  fun fileFor(context: Context, id: String): File? =
    byId(id)?.let { File(modelsDir(context), it.filename) }

  /** ASR model id for the requested whisper size ("base" | "small"). */
  fun asrIdForModel(model: String): String = if (model == "small") "whisper-small" else "whisper-base"
}
