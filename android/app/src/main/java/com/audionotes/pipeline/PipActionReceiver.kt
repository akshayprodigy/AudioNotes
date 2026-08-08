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
      ACTION_PAUSE -> {
        CaptureController.applyPause(true)
        // Swap the icon (Pause -> Resume) while still in PiP.
        MainActivity.current?.let { PipController.updateParams(it) }
      }
      ACTION_RESUME -> {
        CaptureController.applyPause(false)
        MainActivity.current?.let { PipController.updateParams(it) }
      }
      ACTION_STOP -> {
        // stop() blocks up to 5s waiting for the flush and must not run on the main thread.
        // goAsync keeps the broadcast alive while a worker thread does it. STOP ends capture,
        // which takes the activity out of PiP, so there is nothing to refresh afterwards.
        val result = goAsync()
        Thread {
          try { CaptureController.stop(context.applicationContext) }
          catch (e: Exception) { Log.e(TAG, "stop failed", e) }
          finally { result.finish() }
        }.start()
      }
    }
  }

  companion object {
    private const val TAG = "PipActionReceiver"
    const val ACTION_PAUSE = "com.audionotes.pip.PAUSE"
    const val ACTION_RESUME = "com.audionotes.pip.RESUME"
    const val ACTION_STOP = "com.audionotes.pip.STOP"
  }
}
