package com.audionotes.pipeline

import android.app.ActivityManager
import android.content.Context
import android.util.Log
import com.audionotes.data.ModelCatalog
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * LlmModule — on-device text generation (llama.cpp / Qwen) for minutes enhancement.
 * Holds a single loaded-model handle; the JS layer does load() -> generate()* -> unload().
 * Device-capability gated: weak devices silently fall back to the rule-based minutes floor.
 */
class LlmModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  @Volatile private var handle: Long = 0L

  override fun getName() = "Llm"

  /** The Qwen model has been downloaded. */
  @ReactMethod
  fun available(promise: Promise) {
    val f = ModelCatalog.fileFor(ctx, "llm-qwen")
    promise.resolve(f != null && f.exists() && f.length() > 0)
  }

  /** Rough device gate: enough RAM to run a ~1.5B Q4 model without thrashing. */
  @ReactMethod
  fun capable(promise: Promise) {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
    val enoughRam = mem.totalMem >= 3L * 1024 * 1024 * 1024 // >= 3 GB total
    promise.resolve(enoughRam)
  }

  @ReactMethod
  fun load(promise: Promise) {
    if (handle != 0L) {
      promise.resolve(true)
      return
    }
    val f = ModelCatalog.fileFor(ctx, "llm-qwen")
    if (f == null || !f.exists()) {
      promise.resolve(false)
      return
    }
    Thread {
      try {
        val threads = maxOf(1, Runtime.getRuntime().availableProcessors() / 2)
        val h = NativeBridge.nativeLlmLoad(f.absolutePath, 8192, threads)
        handle = h
        promise.resolve(h != 0L)
      } catch (e: Exception) {
        Log.e("Llm", "load failed", e)
        promise.resolve(false)
      }
    }.start()
  }

  @ReactMethod
  fun generate(prompt: String, maxTokens: Double, promise: Promise) {
    val h = handle
    if (h == 0L) {
      promise.reject("not_loaded", "LLM not loaded")
      return
    }
    Thread {
      try {
        promise.resolve(NativeBridge.nativeLlmGenerate(h, prompt, maxTokens.toInt()))
      } catch (e: Exception) {
        promise.reject("generate_failed", e)
      }
    }.start()
  }

  @ReactMethod
  fun unload(promise: Promise) {
    val h = handle
    handle = 0L
    if (h != 0L) {
      try { NativeBridge.nativeLlmFree(h) } catch (_: Exception) {}
    }
    promise.resolve(null)
  }
}
