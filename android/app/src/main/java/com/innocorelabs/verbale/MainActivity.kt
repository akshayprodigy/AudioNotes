package com.innocorelabs.verbale

import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import com.innocorelabs.verbale.pipeline.PipController
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.bridge.ReactContext
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.modules.core.DeviceEventManagerModule

/** Carries a "Notes ready" notification's target meetingId across a cold start until JS is ready
 *  to consume it (see AudioPipelineModule.consumePendingMeetingId). Warm taps use onOpenMeeting. */
object DeepLink {
  @Volatile var pendingMeetingId: String? = null
}

/**
 * Carries audio shared to us from another app until JS can ask for it.
 *
 * Separate from [DeepLink] because the two survive differently: a meetingId is a row that will
 * still be there in an hour, while this is a content:// URI whose read permission is granted to
 * THIS activity instance and dies with the task. Holding it any longer than the mount that
 * consumes it would mean handing JS a URI it can no longer open.
 */
object PendingImport {
  @Volatile var uri: android.net.Uri? = null
}

class MainActivity : ReactActivity() {

  override fun getMainComponentName(): String = "Verbale"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    current = this
    intent?.getStringExtra("openMeetingId")?.let {
      DeepLink.pendingMeetingId = it
      intent.removeExtra("openMeetingId")
    }
    intent?.let { sharedAudio(it)?.let { uri -> PendingImport.uri = uri } }
  }

  /**
   * The audio another app is handing us, if this intent is carrying any.
   *
   * ACTION_SEND is the share sheet; ACTION_VIEW is a file manager opening a recording with us.
   * The type is checked rather than trusted blindly, but loosely: providers routinely send a
   * voice note as application/octet-stream, and the decoder is a better judge of whether a file
   * is audio than a MIME string set by whoever exported it.
   */
  private fun sharedAudio(intent: Intent): android.net.Uri? = when (intent.action) {
    Intent.ACTION_SEND ->
      @Suppress("DEPRECATION")
      (intent.getParcelableExtra(Intent.EXTRA_STREAM) as? android.net.Uri)
    Intent.ACTION_VIEW -> intent.data
    else -> null
  }

  /**
   * A "Notes ready" tap while the app is already running (singleTask) lands here, not in onCreate.
   * Emit onOpenMeeting straight to JS when React is live; if it somehow isn't, fall back to the
   * same pending slot the cold-start path uses so the navigator still picks it up on mount.
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    val id = intent.getStringExtra("openMeetingId")
    if (id != null) intent.removeExtra("openMeetingId")
    setIntent(intent)

    // A share arriving at an app that is already open (singleTask) lands here rather than in
    // onCreate. Emitted straight to JS where React is live, so the import sheet appears over
    // whatever the user was reading instead of waiting for a remount that may never come.
    sharedAudio(intent)?.let { uri ->
      val live: ReactContext? = reactInstanceManagerBridgeless()
      if (live != null) {
        live.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("onSharedAudio", com.facebook.react.bridge.Arguments.createMap().apply {
            putString("uri", uri.toString())
          })
      } else {
        PendingImport.uri = uri
      }
    }

    if (id == null) return
    val ctx: ReactContext? = reactInstanceManagerBridgeless()
    if (ctx != null) {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit("onOpenMeeting", com.facebook.react.bridge.Arguments.createMap().apply {
          putString("meetingId", id)
        })
    } else {
      // Fallback only helps a startup race (context still initializing → onReady consumes this
      // later). If the activity is alive but the React context was torn down without a remount,
      // nothing re-consumes this until the next fresh mount — an accepted, rare edge.
      DeepLink.pendingMeetingId = id
    }
  }

  override fun onDestroy() {
    if (current === this) current = null
    super.onDestroy()
  }

  /** Home / recents while recording -> float into PiP instead of just backgrounding. */
  override fun onUserLeaveHint() {
    if (!PipController.enterIfRecording(this)) super.onUserLeaveHint()
  }

  private var pipView: com.innocorelabs.verbale.pipeline.PipContentView? = null

  override fun onPictureInPictureModeChanged(isInPip: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPip, newConfig)
    // Swap in a NATIVE recorder view for the PiP pane. React Native can't render into the PiP
    // surface (react-native-screens owns the captured window), so we draw it in Android and add
    // it on top of the content root, where it is part of the captured window. Removed on restore.
    if (isInPip) showPipContent() else hidePipContent()
    emitPipMode(isInPip)
  }

  private fun showPipContent() {
    if (pipView != null) return
    val root = findViewById<android.view.ViewGroup>(android.R.id.content) ?: return
    val v = com.innocorelabs.verbale.pipeline.PipContentView(this)
    root.addView(
      v,
      android.view.ViewGroup.LayoutParams(
        android.view.ViewGroup.LayoutParams.MATCH_PARENT,
        android.view.ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
    pipView = v
    // Re-assert the PiP action buttons (Pause/Stop) now that we're in PiP, so they stay attached
    // to the window regardless of how it was entered.
    PipController.updateParams(this)
  }

  private fun hidePipContent() {
    pipView?.let { (it.parent as? android.view.ViewGroup)?.removeView(it) }
    pipView = null
  }

  private fun emitPipMode(inPip: Boolean) {
    val ctx: ReactContext? = reactInstanceManagerBridgeless()
    ctx?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      ?.emit("onPipModeChanged", com.facebook.react.bridge.Arguments.createMap().apply {
        putBoolean("inPip", inPip)
      })
  }

  /** The current React context under bridgeless New Arch. */
  private fun reactInstanceManagerBridgeless(): ReactContext? =
    (application as com.facebook.react.ReactApplication).reactHost?.currentReactContext

  /**
   * A Back press that would actually leave the app -> float into PiP instead while recording.
   *
   * RN calls this only after JS (React Navigation) has declined the back press, so in-app back
   * still works normally; this fires only when the app would otherwise exit.
   */
  override fun invokeDefaultOnBackPressed() {
    if (PipController.enterIfRecording(this)) return
    super.invokeDefaultOnBackPressed()
  }

  companion object {
    /** The live activity, so background receivers (PipActionReceiver) can refresh PiP params. */
    @Volatile var current: MainActivity? = null
  }
}
