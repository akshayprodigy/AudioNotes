package com.audionotes.pipeline

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Pip — device PiP support + the event channel for onPipModeChanged. Entering PiP is done in
 * MainActivity on leave; this module exists so JS can gate UI on support and subscribe to the
 * mode event via NativeEventEmitter(NativeModules.Pip).
 */
class PipModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "Pip"

  @ReactMethod
  fun isSupported(promise: Promise) {
    val a = ctx.currentActivity
    promise.resolve(a != null && PipController.isSupported(a))
  }

  // Required so NativeEventEmitter(NativeModules.Pip) is valid. Events are delivered via the
  // global RCTDeviceEventEmitter from MainActivity.emitPipMode.
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}
}
