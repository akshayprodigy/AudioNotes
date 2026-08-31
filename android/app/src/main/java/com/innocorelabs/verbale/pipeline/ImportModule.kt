package com.innocorelabs.verbale.pipeline

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Log
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.innocorelabs.verbale.PendingImport
import com.innocorelabs.verbale.audio.AudioImport

/**
 * Import — audio recorded somewhere else.
 *
 * Two ways in, and they converge immediately: the user picks a file from inside the app, or another
 * app shares one to us and Android starts MainActivity with it. Both end at [AudioImport.import],
 * which produces an ordinary meeting; from there nothing downstream knows the difference.
 *
 * See src/native/NativeImport.ts.
 */
class ImportModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  override fun getName() = "Import"

  private var pending: Promise? = null

  private val activityListener: ActivityEventListener = object : BaseActivityEventListener() {
    override fun onActivityResult(
      activity: Activity,
      requestCode: Int,
      resultCode: Int,
      data: Intent?,
    ) {
      if (requestCode != PICK_REQUEST) return
      val promise = pending ?: return
      pending = null
      val uri = data?.data
      if (resultCode != Activity.RESULT_OK || uri == null) {
        // A cancelled picker is not an error. Resolving null lets the caller do nothing, where a
        // rejection would put "Could not import" on screen for a decision the user just made.
        promise.resolve(null)
        return
      }
      runImport(uri, promise)
    }
  }

  init {
    ctx.addActivityEventListener(activityListener)
  }

  override fun invalidate() {
    ctx.removeActivityEventListener(activityListener)
    super.invalidate()
  }

  /**
   * Open the system file picker and import whatever comes back.
   *
   * ACTION_OPEN_DOCUMENT rather than ACTION_GET_CONTENT: it returns a durable, permissioned URI
   * from any provider — Drive, Files, a USB stick — instead of whatever the sending app felt like.
   */
  @ReactMethod
  fun pick(promise: Promise) {
    val activity = ctx.currentActivity
    if (activity == null) {
      promise.reject("no_activity", "The app is not in the foreground")
      return
    }
    if (pending != null) {
      promise.reject("busy", "Already importing")
      return
    }
    pending = promise
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "audio/*"
      // Some providers file voice notes under a container type rather than an audio one, and a
      // picker that greys out the file the user came to get is worse than one that shows a few
      // it cannot read.
      putExtra(
        Intent.EXTRA_MIME_TYPES,
        arrayOf("audio/*", "application/ogg", "application/octet-stream", "video/mp4"),
      )
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    try {
      activity.startActivityForResult(intent, PICK_REQUEST)
    } catch (e: Throwable) {
      pending = null
      promise.reject("no_picker", "This phone has no file picker")
    }
  }

  /**
   * Hand JS the file another app shared, exactly once.
   *
   * Mirrors AudioPipelineModule.consumePendingMeetingId: MainActivity stashes the URI before React
   * exists, and the navigator asks for it on mount.
   */
  @ReactMethod
  fun consumePendingImport(promise: Promise) {
    val uri = PendingImport.uri
    PendingImport.uri = null
    if (uri == null) {
      promise.resolve(null)
      return
    }
    promise.resolve(
      Arguments.createMap().apply {
        putString("uri", uri.toString())
        putString("name", AudioImport.displayName(ctx, uri))
      },
    )
  }

  /** Import a URI the caller already has — the share-target path, after JS has confirmed it. */
  @ReactMethod
  fun importUri(uri: String, promise: Promise) {
    runImport(Uri.parse(uri), promise)
  }

  /**
   * Decode off the JS thread, then hand the meeting to the same foreground service a recording
   * uses.
   *
   * Processing is enqueued here rather than in JS so a decode that finishes while the user is
   * elsewhere in the app still gets transcribed — the service is what survives the screen going
   * away, and the whole point of importing is usually to walk off and let it work.
   */
  private fun runImport(uri: Uri, promise: Promise) {
    Thread {
      try {
        val meetingId = AudioImport.import(ctx, uri) { done, total ->
          emit(
            "onImportProgress",
            Arguments.createMap().apply {
              putDouble("doneMs", done.toDouble())
              putDouble("totalMs", total.toDouble())
            },
          )
        }
        try {
          ProcessingService.enqueue(ctx, meetingId)
        } catch (e: Throwable) {
          // The audio is safely on disk and the meeting is 'captured', so the next foreground
          // sweep picks it up. Worth a log, not a failed import.
          Log.w(TAG, "could not start processing for $meetingId", e)
        }
        promise.resolve(meetingId)
      } catch (e: AudioImport.ImportError) {
        promise.reject("import_failed", e.message)
      } catch (e: Throwable) {
        Log.e(TAG, "import failed", e)
        promise.reject("import_failed", "That file could not be imported")
      }
    }.start()
  }

  private fun emit(event: String, map: com.facebook.react.bridge.WritableMap) {
    try {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(event, map)
    } catch (_: Throwable) {
    }
  }

  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}

  private companion object {
    const val TAG = "Import"
    const val PICK_REQUEST = 0x9101
  }
}
