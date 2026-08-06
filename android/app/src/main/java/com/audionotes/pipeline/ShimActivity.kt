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
    // Off the main thread: start() writes a row to the encrypted database.
    val app = applicationContext
    Thread {
      val id = CaptureController.start(app)
      Log.i(TAG, "quick start -> $id")
    }.start()
  }
}
