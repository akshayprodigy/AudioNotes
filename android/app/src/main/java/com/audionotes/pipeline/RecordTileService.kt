package com.audionotes.pipeline

import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.util.Log
import androidx.annotation.RequiresApi

/**
 * Start or stop a recording from the Quick Settings panel.
 *
 * The fastest route into a meeting that exists on Android: two swipes from any app, or from the
 * lock screen, without finding an icon. It is also the surface that keeps working when the user
 * declines the "display over other apps" permission the floating bubble needs — which many people
 * will, and reasonably so.
 *
 * STARTING goes through [ShimActivity] rather than calling CaptureController directly. A tile
 * click does not make the app foreground, and a background app may not start a microphone
 * foreground service; called directly the tile would appear to do nothing at all. STOPPING has no
 * such restriction and runs here.
 */
@RequiresApi(Build.VERSION_CODES.N)
class RecordTileService : TileService(), CaptureListener {

  private companion object {
    const val TAG = "RecordTile"
  }

  override fun onStartListening() {
    super.onStartListening()
    CaptureController.addListener(this)
    render()
  }

  override fun onStopListening() {
    CaptureController.removeListener(this)
    super.onStopListening()
  }

  override fun onCaptureStarted(meetingId: String) = render()
  override fun onCaptureEnded(meetingId: String, reason: String) = render()
  override fun onPausedChanged(paused: Boolean) = render()

  private fun render() {
    val tile = qsTile ?: return
    val recording = CaptureController.isRecording
    // The flush after Stop takes up to five seconds, during which isRecording is already false.
    // Left as INACTIVE the tile read "Tap to record", and a second tap started nothing at all
    // because CaptureController.start refuses while stopping — a control that lies and then
    // silently does nothing.
    val stopping = CaptureController.stopping
    tile.state = when {
      stopping -> Tile.STATE_UNAVAILABLE
      recording -> Tile.STATE_ACTIVE
      else -> Tile.STATE_INACTIVE
    }
    tile.label = getString(com.audionotes.R.string.tile_label)
    tile.icon = Icon.createWithResource(this, com.audionotes.R.drawable.ic_notification_rec)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      tile.subtitle = when {
        stopping -> getString(com.audionotes.R.string.tile_finishing)
        CaptureController.paused -> getString(com.audionotes.R.string.tile_paused)
        recording -> getString(com.audionotes.R.string.tile_recording)
        else -> getString(com.audionotes.R.string.tile_idle)
      }
    }
    tile.updateTile()
  }

  override fun onClick() {
    super.onClick()
    if (CaptureController.stopping) return // still saving the last one
    if (CaptureController.isRecording) {
      // Allowed from the background, and it must not block the UI thread — stop() waits for the
      // capture service to flush the PCM.
      val app = applicationContext
      Thread { CaptureController.stop(app) }.start()
      render() // paints the UNAVAILABLE "Finishing…" state; onCaptureEnded repaints when done
      return
    }

    val intent = Intent(this, ShimActivity::class.java).apply {
      putExtra(ShimActivity.EXTRA_ROUTE, ShimActivity.ROUTE_QUICK_START)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
    }
    val pi = PendingIntent.getActivity(
      this, 0, intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        // The Intent overload is deprecated at 34 and throws outright for apps targeting 34+,
        // which this one does. Only the PendingIntent form is usable here.
        startActivityAndCollapse(pi)
      } else {
        @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
        startActivityAndCollapse(intent)
      }
    } catch (e: Exception) {
      Log.w(TAG, "could not start recording from the tile", e)
    }
  }

  /** Tapped from a locked screen: ask for the unlock first, then run the same click path. */
  override fun onTileAdded() {
    super.onTileAdded()
    render()
  }
}
