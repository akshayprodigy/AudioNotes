package com.innocorelabs.verbale.pipeline

import android.content.Context
import android.util.Log
import com.innocorelabs.verbale.billing.LicenceStore
import com.innocorelabs.verbale.data.ModelCatalog

/**
 * The one embedding-model handle in the process.
 *
 * 37 MB resident is cheap and loading takes ~100 ms, so it is loaded on first use and kept until
 * memory pressure (MainApplication.onTrimMemory) or an explicit release. Every caller — the
 * EMBED stage, the backfill, search, Ask — shares it under one lock, because a llama context is
 * not re-entrant and two callers interleaving batches would read each other's vectors.
 *
 * `available` is the whole gate, the same shape as the writer's: entitled AND the file on disk.
 * A lapsed subscriber keeps the weights and loses the use of them. Nothing here is a second
 * paywall — it is the same one, asked before a model is looked for.
 */
object EmbedRuntime {
  private const val TAG = "Embed"
  const val MODEL_ID = "embed-bge-small"
  private val lock = Any()
  @Volatile private var handle = 0L

  fun modelFile(ctx: Context) =
    ModelCatalog.fileFor(ctx, MODEL_ID)?.takeIf { it.exists() && it.length() > 0 }

  fun available(ctx: Context): Boolean = LicenceStore.entitled(ctx) && modelFile(ctx) != null

  /**
   * Unit vectors, one per text and in order, or null when the model cannot be used (not
   * entitled, not installed, failed to load, or a JNI answer of the wrong shape). A text the
   * model could not embed is an all-zero row — callers drop those rather than store them.
   */
  fun embed(ctx: Context, texts: List<String>): List<FloatArray>? {
    if (texts.isEmpty()) return emptyList()
    synchronized(lock) {
      val h = ensureLoaded(ctx) ?: return null
      val dim = NativeBridge.nativeEmbedDim(h)
      val flat = NativeBridge.nativeEmbedTexts(h, texts.toTypedArray())
      if (dim <= 0 || flat.size != dim * texts.size) return null
      return List(texts.size) { i -> flat.copyOfRange(i * dim, (i + 1) * dim) }
    }
  }

  fun release() {
    synchronized(lock) {
      if (handle != 0L) NativeBridge.nativeEmbedFree(handle)
      handle = 0L
    }
  }

  private fun ensureLoaded(ctx: Context): Long? {
    if (handle != 0L) return handle
    if (!available(ctx)) return null
    val f = modelFile(ctx) ?: return null
    NativeBridge.ensureLoaded(ctx)
    val threads = maxOf(1, Runtime.getRuntime().availableProcessors() / 2)
    val t0 = System.currentTimeMillis()
    val h = NativeBridge.nativeEmbedLoad(f.absolutePath, threads)
    if (h == 0L) {
      Log.w(TAG, "embedding model failed to load from ${f.name}")
      return null
    }
    Log.i(TAG, "embedding model loaded in ${System.currentTimeMillis() - t0}ms")
    handle = h
    return h
  }
}
