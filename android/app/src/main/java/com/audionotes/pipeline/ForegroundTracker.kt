package com.audionotes.pipeline

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log

/**
 * Shows the floating recorder bubble automatically whenever the app leaves the foreground while a
 * recording is running, and hides it again on return.
 *
 * Why this exists: the whole point of the product is "put the phone down and keep recording". Before
 * this, the bubble only appeared if the user had gone to Library → Float and turned it on by hand,
 * so switching to another app mid-meeting left no visible recording indicator and no way to stop
 * without hunting for the app again.
 *
 * Why native and not JS `AppState`: once the app is backgrounded the JS thread can be paused or the
 * React context torn down, so a JS listener is not a dependable place to react to backgrounding.
 * Activity lifecycle callbacks always run.
 *
 * Registered from [com.audionotes.MainApplication.onCreate].
 */
object ForegroundTracker : Application.ActivityLifecycleCallbacks {

  private const val TAG = "ForegroundTracker"

  /** Number of started (visible) activities. 0 means the app is in the background. */
  private var started = 0

  /** True when we put the bubble up ourselves, so we only take it down again if we did. */
  private var autoShown = false

  /**
   * The Settings toggle, read from the database rather than held in memory.
   *
   * It used to be a plain `var` that defaulted to true and had no writer anywhere — so the switch
   * it claimed to be "set from Settings" did not exist, and after a process restart an in-memory
   * flag would have been wrong anyway. Read on each background transition; that happens at most
   * once per app switch, so the cost is irrelevant next to being correct.
   */
  private fun autoFloatEnabled(activity: Activity): Boolean =
    try {
      com.audionotes.data.AudioDb.get(activity).getSetting("floatEnabled") != "0"
    } catch (_: Exception) {
      true
    }

  val isForeground: Boolean get() = started > 0

  fun register(app: Application) {
    app.registerActivityLifecycleCallbacks(this)
  }

  private fun canDrawOverlays(a: Activity): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(a)

  override fun onActivityStarted(activity: Activity) {
    started++
    if (started == 1 && autoShown) {
      // Back in the app — the in-app recorder UI takes over, so drop the bubble.
      activity.startService(
        Intent(activity, OverlayService::class.java).apply { action = OverlayService.ACTION_HIDE },
      )
      autoShown = false
      Log.i(TAG, "returned to foreground; auto-bubble hidden")
    }
  }

  override fun onActivityStopped(activity: Activity) {
    started = (started - 1).coerceAtLeast(0)
    if (started > 0) return // just moving between our own activities
    if (!CaptureController.isRecording || !autoFloatEnabled(activity)) return
    // The user dragged it into the pocket for this meeting. Bringing it straight back on the next
    // app switch would make the gesture look broken.
    if (OverlayService.isDismissed()) return
    if (!canDrawOverlays(activity)) {
      // Nothing we can do from the background; the recording continues via the foreground
      // service and its notification, which is still a working (if less convenient) control.
      Log.i(TAG, "backgrounded while recording but overlay permission not granted")
      return
    }
    activity.startService(
      Intent(activity, OverlayService::class.java).apply { action = OverlayService.ACTION_SHOW },
    )
    autoShown = true
    Log.i(TAG, "backgrounded while recording; auto-bubble shown")
  }

  override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
  override fun onActivityResumed(activity: Activity) {}
  override fun onActivityPaused(activity: Activity) {}
  override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
  override fun onActivityDestroyed(activity: Activity) {}
}
