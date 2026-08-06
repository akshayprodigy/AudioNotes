package com.audionotes.pipeline

import android.app.Activity
import android.os.Bundle
import android.util.Log

/**
 * An invisible activity that exists purely to be briefly visible.
 *
 * Android will not let a background app start a microphone foreground service. A Quick Settings
 * tile is exactly that case: the tile process is ours, but nothing of ours is on screen, so
 * calling [CaptureController.start] straight from the tile is refused and the user taps a control
 * that silently does nothing.
 *
 * Launching this first makes the app momentarily foreground, which makes the service start legal.
 * It finishes immediately, draws nothing, and is excluded from Recents, so the user sees the
 * Quick Settings panel collapse and a recording begin — no app, no flash of UI.
 *
 * [ForegroundTracker] deliberately ignores this activity. Counting it as "the app came to the
 * foreground" would tear down the floating bubble every time the tile was used.
 */
class ShimActivity : Activity() {

  companion object {
    const val EXTRA_ROUTE = "route"
    const val ROUTE_QUICK_START = "quick_start"
    private const val TAG = "ShimActivity"
  }

  /**
   * The service start must happen SYNCHRONOUSLY here, before finish().
   *
   * The point of this activity is to be foreground at the instant the microphone foreground
   * service is started. Handing the start to a worker thread and finishing immediately meant the
   * activity was usually gone by the time the start actually ran — so the app was in the
   * background again and the very restriction this exists to satisfy was violated. The tile would
   * appear to do nothing, intermittently, which is the worst way for it to fail.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    when (intent?.getStringExtra(EXTRA_ROUTE)) {
      ROUTE_QUICK_START -> quickStart()
      else -> Log.w(TAG, "no route; nothing to do")
    }
    finish()
    // No animation: this activity is machinery, and a window transition would make it look like
    // the app opened and closed for no reason.
    overridePendingTransition(0, 0)
  }

  private fun quickStart() {
    if (CaptureController.isRecording) return
    if (!CaptureController.hasMicPermission(this)) {
      // The tile cannot request a runtime permission usefully — there is no UI to explain why —
      // so send the user into the app, where the recorder screen asks properly.
      Log.i(TAG, "quick start without mic permission; opening the app instead")
      try {
        startActivity(
          android.content.Intent(this, com.audionotes.MainActivity::class.java)
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      } catch (e: Exception) {
        Log.w(TAG, "could not open the app", e)
      }
      return
    }
    // On the main thread, deliberately. start() writes one row to an already-open encrypted
    // database and then calls startForegroundService — a few milliseconds — and that start has to
    // happen while this activity is still the foreground window. Correctness beats the frame.
    val id = try {
      CaptureController.start(applicationContext)
    } catch (e: Exception) {
      Log.e(TAG, "quick start failed", e)
      null
    }
    Log.i(TAG, "quick start -> $id")
  }
}
