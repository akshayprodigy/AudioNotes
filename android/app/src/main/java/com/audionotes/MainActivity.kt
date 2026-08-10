package com.audionotes

import android.content.res.Configuration
import android.os.Bundle
import com.audionotes.pipeline.PipController
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.bridge.ReactContext
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.facebook.react.modules.core.DeviceEventManagerModule

class MainActivity : ReactActivity() {

  override fun getMainComponentName(): String = "AudioNotes"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    current = this
  }

  override fun onDestroy() {
    if (current === this) current = null
    super.onDestroy()
  }

  /** Home / recents while recording -> float into PiP instead of just backgrounding. */
  override fun onUserLeaveHint() {
    if (!PipController.enterIfRecording(this)) super.onUserLeaveHint()
  }

  private var pipView: com.audionotes.pipeline.PipContentView? = null

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
    val v = com.audionotes.pipeline.PipContentView(this)
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
