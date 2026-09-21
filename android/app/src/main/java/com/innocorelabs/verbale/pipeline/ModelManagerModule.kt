package com.innocorelabs.verbale.pipeline

import android.util.Log
import com.innocorelabs.verbale.billing.LicenceStore
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ModelCatalog
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * ModelManager — staged, resumable, checksum-verified model download. Models are NOT bundled
 * (a 2.5GB APK kills install conversion); they download on demand. See src/native/NativeModelManager.ts.
 */
class ModelManagerModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "ModelManager"

  @ReactMethod
  fun list(promise: Promise) {
    val arr = JSONArray()
    // Only what can actually be used. A model whose engine nothing routes to would otherwise sit
    // in the list inviting a download that can never run — 972 MB, in Qwen3-ASR's case.
    for (spec in ModelCatalog.ALL.filter { it.offered }) {
      val dir = ModelCatalog.modelsDir(ctx)
      arr.put(
        JSONObject()
          .put("id", spec.id)
          .put("name", spec.name)
          .put("purpose", spec.purpose)
          .put("detail", spec.detail)
          .put("kind", spec.kind)
          .put("required", spec.required)
          // Size must MATCH the catalog, not merely be non-zero. Two cases this catches that
          // "exists and is not empty" does not: a download interrupted part-way leaves a
          // plausible-looking file that would be loaded as weights, and — the reason this
          // changed — swapping a model keeps the same filename, so an existing install would
          // otherwise report the superseded file as installed and never fetch the new one.
          // Compared against the size rather than the sha256 deliberately: this runs on every
          // list() call, and hashing the 1.1 GB LLM each time to catch a rare case is not worth
          // it. The full sha256 is still verified after every download.
          // Every part, not just the first. A six-file model with five files on disk is not
          // installed, and reporting it as such would hand the engine a directory it cannot load.
          .put("installed", spec.parts.all { p ->
            File(dir, p.filename).let {
              it.exists() &&
                // The catalog only knows the 64-bit runtime. A 32-bit bench build (the 2019
                // Galaxy Tab A) has the 32-bit one hand-placed at the same name and a different
                // size; reporting it "not installed" would make onboarding fetch the 64-bit one
                // over it and the pipeline could never load again. Existence is the whole test there.
                (it.length() == p.sizeBytes || (spec.kind == "runtime" && !DiarBudget.is64BitProcess()))
            }
          })
          // So the UI can say "Pro" against it rather than offering a download that will be
          // refused. The refusal in download() is the enforcement; this is only the honesty.
          .put("needsSubscription", ModelCatalog.needsSubscription(spec))
          // Why THIS phone cannot run it, as the sentence every screen prints — or null. The
          // screens used to offer the writer to every phone and let the Summary tab break the
          // news after a 1.1 GB download; now the row carries the answer before the button.
          .put("unsupportedReason", DeviceFit.unsupportedReason(ctx, spec) ?: JSONObject.NULL)
          .put("sizeBytes", spec.sizeBytes),
      )
    }
    promise.resolve(arr.toString())
  }

  /**
   * The facts about the phone itself, for the screens that offer a download: whether the engines
   * can run on its processor at all (a sentence, or null) and how much disk is free. One call, so
   * onboarding and the Pro screen say the same thing DeviceFit says, before the tap.
   */
  @ReactMethod
  fun deviceFit(promise: Promise) {
    promise.resolve(
      JSONObject()
        .put("cpuReason", DeviceFit.cpuReason() ?: JSONObject.NULL)
        .put("freeBytes", DeviceFit.freeBytes(ctx))
        .toString(),
    )
  }

  @ReactMethod
  fun download(id: String, promise: Promise) {
    val spec = ModelCatalog.byId(id)
    if (spec == null) {
      promise.reject("no_model", "unknown model $id")
      return
    }
    // See list(): the download would replace the hand-placed 32-bit runtime with the 64-bit one.
    if (spec.kind == "runtime" && !DiarBudget.is64BitProcess()) {
      promise.reject("runtime_32bit", "The 32-bit runtime is placed by hand on this device; nothing to download.")
      return
    }
    // The phone before the subscription: a trial on a 2 GB phone must hear "needs 4 GB", not
    // "subscription required". Like the subscription check, these are the enforcement — the
    // screens hide the button, but a gate in the bundle is a gate anyone can edit.
    DeviceFit.cpuReason()?.let {
      promise.reject("cpu_unsupported", it)
      return
    }
    DeviceFit.unsupportedReason(ctx, spec)?.let {
      promise.reject("device_unsupported", it)
      return
    }
    // Checked here rather than in JS, for the same reason Narrator.run checks there: a gate in
    // the bundle is a gate anyone can edit. This is the one that has to hold.
    // entitled(), not isPaid: an entitlement to run a model the phone is not allowed to download
    // is a trial of nothing.
    if (ModelCatalog.needsSubscription(spec) && !LicenceStore.entitled(ctx)) {
      promise.reject(
        "subscription_required",
        "${spec.name} is part of the subscription.",
      )
      return
    }
    // Already on disk? Then this is a no-op, and must not touch the network.
    //
    // Nothing upstream checked. Onboarding, Settings and the paywall all call download() for every
    // model they want, so re-entering onboarding re-fetched the whole 114 MB — over the user's
    // mobile data, under a screen that says "Downloading once", and now off our own mirror's
    // egress. Observed on a device: libonnxruntime.so and silero_vad.onnx were both served again
    // in full, byte for byte, having never left the phone.
    //
    // Guarded here rather than in each caller because this is the one path all three share, which
    // is the same reason the subscription check above lives here.
    //
    // "Installed" means exactly what list() means by it: present AND the catalog's size. An
    // interrupted download lives in a .part file and never has this name; a swapped model changes
    // the size. Re-hashing 1.1 GB on every call to catch what download() already verified once
    // would cost more than the case is worth.
    val modelsDir = ModelCatalog.modelsDir(ctx)
    val allPresent = spec.parts.all { p ->
      File(modelsDir, p.filename).let { it.exists() && it.length() == p.sizeBytes }
    }
    if (allPresent) {
      // A leftover .part is garbage once the real file is complete, and returning early is what
      // makes it permanent: nothing else ever looks at these. Before this early return, a later
      // download resumed into the .part and eventually renamed it away, so the leak had no way to
      // last. Interrupt the 1.1 GB writer model and get it another way and that is a gigabyte kept
      // for nothing, on a phone, forever.
      for (p in spec.parts) File(modelsDir, p.filename + ".part").delete()
      emitProgress(id, spec.sizeBytes, spec.sizeBytes)
      promise.resolve(File(modelsDir, spec.parts.first().filename).absolutePath)
      return
    }
    // The disk before the network. What is still to come is every part not yet complete, less the
    // bytes a .part already holds (they are on the disk already and the resume keeps them).
    val remaining = spec.parts.sumOf { p ->
      val done = File(modelsDir, p.filename).let { it.exists() && it.length() == p.sizeBytes }
      if (done) 0L else (p.sizeBytes - File(modelsDir, p.filename + ".part").length()).coerceAtLeast(0L)
    }
    val free = DeviceFit.freeBytes(ctx)
    if (!DeviceFit.spaceFits(remaining, free)) {
      promise.reject("no_space", DeviceFit.spaceReason(spec.name, remaining, free))
      return
    }
    Thread {
      try {
       // One part at a time, each fetched, hashed and renamed exactly as a single-file model
       // always was. Sequential rather than parallel: these are hundreds of megabytes over a
       // phone's connection, and three at once is slower than three in a row as well as being
       // three ways to run the battery down.
       var doneBytes = 0L
       for (part_ in spec.parts) {
        val dest = File(modelsDir, part_.filename)
        val part = File(modelsDir, part_.filename + ".part")
        // Parts may live in a subdirectory ("qwen3-asr/tokenizer/vocab.json"), which will not
        // exist on a fresh install.
        dest.parentFile?.mkdirs()
        if (dest.exists() && dest.length() == part_.sizeBytes) {
          doneBytes += part_.sizeBytes
          emitProgress(id, doneBytes, spec.sizeBytes)
          continue
        }
        // Try each source in turn — our mirror first, upstream as the fallback. A source that
        // fails part-way leaves a .part file, and the next attempt resumes into it via Range,
        // which is safe across sources ONLY because the bytes are identical by definition: the
        // sha256 below is what proves it, and a mismatch discards the file rather than loading it.
        val sources = ModelCatalog.sourcesFor(part_)
        var lastError: Exception? = null
        var fetched = false
        for ((i, source) in sources.withIndex()) {
          try {
            fetchTo(part, source, id)
            fetched = true
            break
          } catch (e: Exception) {
            lastError = e
            Log.w("ModelManager", "source ${i + 1}/${sources.size} failed for $id: $source", e)
          }
        }
        if (!fetched) throw lastError ?: IllegalStateException("no source for $id")

        if (part_.sha256.isNotEmpty()) {
          val actual = sha256(part)
          if (!actual.equals(part_.sha256, ignoreCase = true)) {
            // Discard it. Left in place, the next attempt resumes into bytes already known to be
            // wrong and can never converge — the download would fail identically forever.
            part.delete()
            throw IllegalStateException("checksum mismatch for $id (got $actual)")
          }
        } else {
          Log.w("ModelManager", "no sha256 for $id — skipping verification")
        }

        if (dest.exists()) dest.delete()
        if (!part.renameTo(dest)) throw IllegalStateException("could not finalize $id")
        doneBytes += part_.sizeBytes
        emitProgress(id, doneBytes, spec.sizeBytes)
       }

        val first = File(modelsDir, spec.parts.first().filename)
        AudioDb.get(ctx).upsertModel(
          spec.id, spec.name, spec.kind, first.absolutePath, spec.parts.first().sha256,
          spec.sizeBytes, System.currentTimeMillis(),
        )
        emitProgress(id, spec.sizeBytes, spec.sizeBytes)
        promise.resolve(first.absolutePath)
      } catch (e: Exception) {
        Log.e("ModelManager", "download failed for $id", e)
        promise.reject("download_failed", e)
      }
    }.start()
  }

  /**
   * Stream one source into `part`, resuming from whatever is already there. Throws on any
   * non-2xx, so the caller can fall through to the next source — without the status check a CDN
   * serving an HTML 404 page would be written out as model weights and only caught later by the
   * checksum, after a full download.
   */
  private fun fetchTo(part: File, source: String, id: String) {
    var existing = if (part.exists()) part.length() else 0L
    val conn = (URL(source).openConnection() as HttpURLConnection).apply {
      instanceFollowRedirects = true
      connectTimeout = 30000
      readTimeout = 30000
      if (existing > 0) setRequestProperty("Range", "bytes=$existing-")
    }
    conn.connect()
    val code = conn.responseCode
    if (code !in 200..299) {
      conn.disconnect()
      throw IllegalStateException("HTTP $code from $source")
    }
    // If the server ignored the Range request, start over.
    if (existing > 0 && code != HttpURLConnection.HTTP_PARTIAL) existing = 0L
    val total = existing + conn.contentLengthLong.coerceAtLeast(0L)

    // What THIS call pulled down, not what a resumed part file already held.
    var fetched = 0L
    conn.inputStream.use { input ->
      java.io.FileOutputStream(part, existing > 0).use { out ->
        val buf = ByteArray(1 shl 16)
        var downloaded = existing
        var lastEmit = 0L
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          out.write(buf, 0, n)
          downloaded += n
          fetched += n
          if (downloaded - lastEmit > 512 * 1024) {
            emitProgress(id, downloaded, total)
            lastEmit = downloaded
          }
        }
      }
    }
    conn.disconnect()

    // One row per file actually fetched, with the host it came from. These are the largest
    // numbers the privacy screen shows, and they are the argument rather than an embarrassment:
    // this much came down so that nothing has to go up.
    AudioDb.get(ctx).recordNetworkEvent(
      kind = "models",
      host = try { URL(source).host } catch (e: Exception) { source },
      sent = 0L, // a GET sends headers, not a body; the screen says headers are excluded
      received = fetched,
      detail = id,
    )
  }

  @ReactMethod
  fun verify(id: String, promise: Promise) {
    val spec = ModelCatalog.byId(id)
    if (spec == null) {
      promise.resolve(false)
      return
    }
    try {
      // Every part has to hold. One good file out of six is not a verified model.
      for (p in spec.parts) {
        val f = File(ModelCatalog.modelsDir(ctx), p.filename)
        if (!f.exists()) { promise.resolve(false); return }
        if (p.sha256.isEmpty()) continue // nothing to check this one against
        if (!sha256(f).equals(p.sha256, ignoreCase = true)) { promise.resolve(false); return }
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("verify_failed", e)
    }
  }

  @ReactMethod
  fun remove(id: String, promise: Promise) {
    val spec = ModelCatalog.byId(id)
    if (spec != null) {
      val dir = ModelCatalog.modelsDir(ctx)
      for (p in spec.parts) {
        File(dir, p.filename).delete()
        File(dir, p.filename + ".part").delete()  // a half-finished part is storage too
      }
      try { AudioDb.get(ctx).deleteModel(id) } catch (_: Exception) {}
    }
    promise.resolve(null)
  }

  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}

  private fun sha256(f: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    f.inputStream().use { input ->
      val buf = ByteArray(1 shl 16)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        md.update(buf, 0, n)
      }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }

  private fun emitProgress(id: String, downloaded: Long, total: Long) {
    val map = WritableNativeMap().apply {
      putString("id", id)
      putDouble("downloaded", downloaded.toDouble())
      putDouble("total", total.toDouble())
    }
    ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("onModelProgress", map)
  }
}
