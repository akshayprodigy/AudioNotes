package com.innocorelabs.verbale.pipeline

import android.util.Log
import com.innocorelabs.verbale.data.ModelCatalog
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

  /** The device gate, from the one place that also tells the person about it (DeviceFit). */
  @ReactMethod
  fun capable(promise: Promise) {
    promise.resolve(DeviceFit.writerFits(ctx))
  }

  /**
   * The one handle, loaded on the calling thread. Shared by load() and ask(): a person who asks
   * a second question must not pay the load twice, and a screen that called load() first must
   * not see ask() load a second copy. Synchronized because two asks in flight would otherwise
   * both find `handle == 0` and each load a 1.1 GB model.
   */
  @Synchronized
  private fun ensureLoadedHandle(): Long {
    if (handle != 0L) return handle
    val f = ModelCatalog.fileFor(ctx, "llm-qwen")
    if (f == null || !f.exists()) return 0L
    // Loads libaudionotes.so + its downloaded its models dependency first.
    NativeBridge.ensureLoaded(ctx)
    val threads = maxOf(1, Runtime.getRuntime().availableProcessors() / 2)
    val h = NativeBridge.nativeLlmLoad(f.absolutePath, 8192, threads, /*greedy=*/true, /*repeatPenalty=*/1.15f)
    handle = h
    return h
  }

  @ReactMethod
  fun load(promise: Promise) {
    if (handle != 0L) {
      promise.resolve(true)
      return
    }
    Thread {
      try {
        promise.resolve(ensureLoadedHandle() != 0L)
      } catch (e: Exception) {
        Log.e("Llm", "load failed", e)
        promise.resolve(false)
      }
    }.start()
  }

  /**
   * Ask this meeting (sub-project 5). Resolves `{refusal, id, answer, cites, nothing}` — see
   * Asker for the gate and the shape. The writer stays resident for the next question; the Ask
   * screen calls unload() when it leaves.
   */
  @ReactMethod
  fun ask(meetingId: String, question: String, promise: Promise) {
    Thread {
      try {
        val r = Asker.ask(ctx, meetingId, question) { ensureLoadedHandle() }
        promise.resolve(
          org.json.JSONObject()
            .put("refusal", r.refusal?.name ?: org.json.JSONObject.NULL)
            .put("id", r.id ?: org.json.JSONObject.NULL)
            .put("answer", r.answer)
            .put("cites", org.json.JSONArray(r.citesJson))
            .put("nothing", r.nothing)
            .toString(),
        )
      } catch (e: Throwable) {
        Log.e("Llm", "ask failed", e)
        promise.reject("ask_failed", e)
      }
    }.start()
  }

  /** The meeting's past asks, oldest first. */
  @ReactMethod
  fun asks(meetingId: String, promise: Promise) {
    try {
      promise.resolve(com.innocorelabs.verbale.data.AudioDb.get(ctx).asksJson(meetingId))
    } catch (e: Throwable) {
      promise.reject("asks_failed", e)
    }
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
