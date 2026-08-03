package com.audionotes.pipeline

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Controls the floating recorder bubble (OverlayService) and its "display over other apps"
 * permission. See src/native/NativeOverlay.ts.
 */
class OverlayModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "Overlay"

  @ReactMethod
  fun hasPermission(promise: Promise) {
    val ok = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(ctx)
    promise.resolve(ok)
  }

  @ReactMethod
  fun requestPermission(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(ctx)) {
        val intent = Intent(
          Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
          Uri.parse("package:" + ctx.packageName),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(intent)
      }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("overlay_perm_failed", e)
    }
  }

  @ReactMethod
  fun show(promise: Promise) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(ctx)) {
      promise.reject("no_overlay_permission", "display-over-other-apps not granted")
      return
    }
    val intent = Intent(ctx, OverlayService::class.java).apply { action = OverlayService.ACTION_SHOW }
    ctx.startService(intent)
    promise.resolve(null)
  }

  @ReactMethod
  fun hide(promise: Promise) {
    val intent = Intent(ctx, OverlayService::class.java).apply { action = OverlayService.ACTION_HIDE }
    try { ctx.startService(intent) } catch (_: Exception) {}
    promise.resolve(null)
  }

  @ReactMethod
  fun isRecording(promise: Promise) {
    promise.resolve(CaptureController.isRecording)
  }
}
