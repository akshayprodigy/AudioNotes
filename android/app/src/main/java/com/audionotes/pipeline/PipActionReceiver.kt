package com.audionotes.pipeline

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.audionotes.MainActivity

/**
 * Handles taps on the PiP window's Pause/Resume/Stop buttons. Routes them straight to
 * CaptureController (the capture source of truth), then refreshes the PiP params so the
 * Pause<->Resume icon reflects the new state.
 */
class PipActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      ACTION_PAUSE -> CaptureController.applyPause(true)
      ACTION_RESUME -> CaptureController.applyPause(false)
      ACTION_STOP -> {
        try { CaptureController.stop(context) } catch (e: Exception) { Log.e(TAG, "stop failed", e) }
      }
    }
    // Swap the icon (Pause<->Resume). STOP ends capture, which takes the activity out of PiP anyway.
    (context.applicationContext as? android.app.Application)?.let {
      MainActivity.current?.let { a -> PipController.updateParams(a) }
    }
  }

  companion object {
    private const val TAG = "PipActionReceiver"
    const val ACTION_PAUSE = "com.audionotes.pip.PAUSE"
    const val ACTION_RESUME = "com.audionotes.pip.RESUME"
    const val ACTION_STOP = "com.audionotes.pip.STOP"
  }
}
