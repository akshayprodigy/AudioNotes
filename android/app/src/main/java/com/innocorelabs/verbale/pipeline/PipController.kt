package com.innocorelabs.verbale.pipeline

import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational
import com.innocorelabs.verbale.R

/**
 * Owns everything about the Picture-in-Picture window: whether the device supports it, the
 * params (aspect ratio + action buttons), and entering it. Actions are native RemoteActions that
 * broadcast to PipActionReceiver, so they work at PiP size where a tapped RN view would not.
 */
object PipController {
  private const val REQ_PAUSE = 1
  private const val REQ_STOP = 2
  private const val REQ_MARK = 3

  /** Phone PiP is effectively API 26+; guard so API 24-25 (minSdk) and PiP-disabled devices fall back. */
  fun isSupported(activity: Activity): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

  fun buildParams(activity: Activity): PictureInPictureParams {
    val paused = CaptureController.paused
    val toggle = RemoteAction(
      Icon.createWithResource(activity, if (paused) R.drawable.ic_pip_resume else R.drawable.ic_pip_pause),
      activity.getString(if (paused) R.string.pip_action_resume else R.string.pip_action_pause),
      activity.getString(if (paused) R.string.pip_action_resume_desc else R.string.pip_action_pause_desc),
      pending(activity, REQ_PAUSE, if (paused) PipActionReceiver.ACTION_RESUME else PipActionReceiver.ACTION_PAUSE),
    )
    val stop = RemoteAction(
      Icon.createWithResource(activity, R.drawable.ic_pip_stop),
      activity.getString(R.string.pip_action_stop),
      activity.getString(R.string.pip_action_stop_desc),
      pending(activity, REQ_STOP, PipActionReceiver.ACTION_STOP),
    )
    val mark = RemoteAction(
      Icon.createWithResource(activity, R.drawable.ic_pip_mark),
      activity.getString(R.string.pip_action_mark),
      activity.getString(R.string.pip_action_mark_desc),
      pending(activity, REQ_MARK, PipActionReceiver.ACTION_MARK),
    )
    return PictureInPictureParams.Builder()
      .setAspectRatio(Rational(16, 9))
      .setActions(listOf(toggle, mark, stop))
      .build()
  }

  /** Refresh the params (e.g. to swap the Pause<->Resume icon) while already in PiP. */
  fun updateParams(activity: Activity) {
    if (isSupported(activity)) activity.setPictureInPictureParams(buildParams(activity))
  }

  /** Enter PiP if a recording is running and the device supports it. Returns true if it did. */
  fun enterIfRecording(activity: Activity): Boolean {
    if (!CaptureController.isRecording || !isSupported(activity)) return false
    return try {
      val entered = activity.enterPictureInPictureMode(buildParams(activity))
      if (!entered) android.util.Log.w("PipController", "enterPictureInPictureMode returned false")
      entered
    } catch (e: Exception) {
      // Logged, not swallowed: on the Pixel 7 Pro (Android 17) PiP silently never appeared, and
      // a catch that says nothing is how that stayed unexplained for an afternoon.
      android.util.Log.w("PipController", "enterPictureInPictureMode threw", e)
      false
    }
  }

  private fun pending(activity: Activity, req: Int, action: String): PendingIntent =
    PendingIntent.getBroadcast(
      activity, req,
      Intent(activity, PipActionReceiver::class.java).setAction(action),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
}
