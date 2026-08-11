package com.audionotes.pipeline

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.lang.ref.WeakReference

/** Lets the background ProcessingService emit RN events without owning the module. Best-effort:
 *  a no-op when JS is gone (app killed) — the service + notification are the durable channel.
 *
 *  Emits onStageProgress / onStageComplete / onError to JS via RCTDeviceEventEmitter; best-effort
 *  no-op when JS is gone. */
object AudioPipelineBridge {
  @Volatile private var ref: WeakReference<ReactApplicationContext>? = null

  fun attach(ctx: ReactApplicationContext) { ref = WeakReference(ctx) }

  fun emitProgress(meetingId: String, stage: String, done: Int, total: Int) {
    val m = Arguments.createMap().apply {
      putString("meetingId", meetingId); putString("stage", stage); putInt("chunk", done); putInt("total", total)
    }
    emit("onStageProgress", m)
  }

  fun emitComplete(meetingId: String, outcome: String, message: String?) {
    val m = Arguments.createMap().apply {
      putString("meetingId", meetingId); putString("outcome", outcome); if (message != null) putString("message", message)
    }
    emit(if (outcome == "error") "onError" else "onStageComplete", m)
  }

  private fun emit(event: String, map: com.facebook.react.bridge.WritableMap) {
    val ctx = ref?.get() ?: return
    try {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(event, map)
    } catch (_: Exception) { /* no JS context */ }
  }
}
