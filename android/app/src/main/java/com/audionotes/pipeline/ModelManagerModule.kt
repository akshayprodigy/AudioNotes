package com.audionotes.pipeline

import android.util.Log
import com.audionotes.data.AudioDb
import com.audionotes.data.ModelCatalog
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
    for (spec in ModelCatalog.ALL) {
      val f = File(ModelCatalog.modelsDir(ctx), spec.filename)
      arr.put(
        JSONObject()
          .put("id", spec.id)
          .put("name", spec.name)
          .put("kind", spec.kind)
          // Size must MATCH the catalog, not merely be non-zero. Two cases this catches that
          // "exists and is not empty" does not: a download interrupted part-way leaves a
          // plausible-looking file that would be loaded as weights, and — the reason this
          // changed — swapping a model keeps the same filename, so an existing install would
          // otherwise report the superseded file as installed and never fetch the new one.
          // Compared against the size rather than the sha256 deliberately: this runs on every
          // list() call, and hashing the 1.1 GB LLM each time to catch a rare case is not worth
          // it. The full sha256 is still verified after every download.
          .put("installed", f.exists() && f.length() == spec.sizeBytes)
          .put("sizeBytes", spec.sizeBytes),
      )
    }
    promise.resolve(arr.toString())
  }

  @ReactMethod
  fun download(id: String, promise: Promise) {
    val spec = ModelCatalog.byId(id)
    if (spec == null) {
      promise.reject("no_model", "unknown model $id")
      return
    }
    Thread {
      val dest = File(ModelCatalog.modelsDir(ctx), spec.filename)
      val part = File(dest.parentFile, spec.filename + ".part")
      try {
        var existing = if (part.exists()) part.length() else 0L
        val conn = (URL(spec.url).openConnection() as HttpURLConnection).apply {
          instanceFollowRedirects = true
          connectTimeout = 30000
          readTimeout = 30000
          if (existing > 0) setRequestProperty("Range", "bytes=$existing-")
        }
        conn.connect()
        // If the server ignored the Range request, start over.
        if (existing > 0 && conn.responseCode != HttpURLConnection.HTTP_PARTIAL) {
          existing = 0L
        }
        val total = existing + conn.contentLengthLong.coerceAtLeast(0L)

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
              if (downloaded - lastEmit > 512 * 1024) {
                emitProgress(id, downloaded, total)
                lastEmit = downloaded
              }
            }
          }
        }
        conn.disconnect()

        if (spec.sha256.isNotEmpty()) {
          val actual = sha256(part)
          if (!actual.equals(spec.sha256, ignoreCase = true)) {
            throw IllegalStateException("checksum mismatch for $id (got $actual)")
          }
        } else {
          Log.w("ModelManager", "no sha256 for $id — skipping verification")
        }

        if (dest.exists()) dest.delete()
        if (!part.renameTo(dest)) throw IllegalStateException("could not finalize $id")

        AudioDb.get(ctx).upsertModel(
          spec.id, spec.name, spec.kind, dest.absolutePath, spec.sha256, dest.length(),
          System.currentTimeMillis(),
        )
        emitProgress(id, dest.length(), dest.length())
        promise.resolve(dest.absolutePath)
      } catch (e: Exception) {
        Log.e("ModelManager", "download failed for $id", e)
        promise.reject("download_failed", e)
      }
    }.start()
  }

  @ReactMethod
  fun verify(id: String, promise: Promise) {
    val spec = ModelCatalog.byId(id)
    val f = spec?.let { File(ModelCatalog.modelsDir(ctx), it.filename) }
    if (spec == null || f == null || !f.exists()) {
      promise.resolve(false)
      return
    }
    if (spec.sha256.isEmpty()) {
      promise.resolve(true) // nothing to check against
      return
    }
    try {
      promise.resolve(sha256(f).equals(spec.sha256, ignoreCase = true))
    } catch (e: Exception) {
      promise.reject("verify_failed", e)
    }
  }

  @ReactMethod
  fun remove(id: String, promise: Promise) {
    val spec = ModelCatalog.byId(id)
    if (spec != null) {
      File(ModelCatalog.modelsDir(ctx), spec.filename).delete()
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
