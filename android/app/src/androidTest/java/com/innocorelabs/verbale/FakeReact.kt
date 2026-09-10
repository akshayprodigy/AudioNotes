package com.innocorelabs.verbale

import android.content.Context
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.CatalystInstance
import com.facebook.react.bridge.JavaScriptContextHolder
import com.facebook.react.bridge.JavaScriptModule
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UIManager
import com.facebook.react.bridge.WritableMap
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder

/**
 * The two doubles a test needs to call a `@ReactMethod` directly, in one place.
 *
 * Both started life private to `StorageItemsTest`. A second class needed exactly the same pair the
 * moment `StorageModule.backfillItems` existed, and copying sixty lines of bridge stub is how the
 * copies stop agreeing — the risk here is not the boilerplate, it is a second [NoReactContext]
 * that quietly returns a plausible nothing where this one throws, testing an object production
 * never uses.
 */

/**
 * Records whichever of the eleven Promise methods the module actually calls.
 *
 * [value] is kept as well as [resolved] because a bridge method that resolves the WRONG number is
 * indistinguishable from one that works, from the outside: `backfillItems` resolving the size of
 * the batch it just did rather than the backlog still to go would drain, latch and leave a library
 * half migrated with nothing reporting it.
 */
class RecordingPromise : Promise {
  var resolved = false
  var value: Any? = null
  var rejection: Throwable? = null
  var rejectionCode: String? = null

  private fun fail(code: String?, t: Throwable?) {
    rejectionCode = code
    rejection = t ?: RuntimeException(code ?: "rejected")
  }

  override fun resolve(value: Any?) {
    resolved = true
    this.value = value
  }

  override fun reject(code: String?, message: String?) = fail(code, RuntimeException(message))
  override fun reject(code: String?, throwable: Throwable?) = fail(code, throwable)
  override fun reject(code: String?, message: String?, throwable: Throwable?) = fail(code, throwable)
  override fun reject(code: String?, userInfo: WritableMap) = fail(code, null)
  override fun reject(code: String?, throwable: Throwable?, userInfo: WritableMap) = fail(code, throwable)
  override fun reject(code: String?, message: String?, userInfo: WritableMap) = fail(code, null)
  override fun reject(
    code: String?,
    message: String?,
    throwable: Throwable?,
    userInfo: WritableMap?,
  ) = fail(code, throwable)
  override fun reject(throwable: Throwable) = fail(null, throwable)
  override fun reject(throwable: Throwable, userInfo: WritableMap) = fail(null, throwable)
  @Deprecated("Prefer reject(code, message)", ReplaceWith("reject(\"code\", message)"))
  override fun reject(message: String) = fail(null, RuntimeException(message))
}

/**
 * A ReactApplicationContext with no React in it.
 *
 * `ReactApplicationContext` is abstract in RN 0.86 and every abstract member below is part of the
 * bridge — modules, the catalyst instance, the JS call invoker. `StorageModule` uses its context as
 * a plain `Context` and nothing else, so every one of them throws rather than returning a plausible
 * nothing: if one of its methods ever starts needing the bridge, the test says so instead of
 * quietly testing a different object than production uses.
 */
class NoReactContext(base: Context) : ReactApplicationContext(base) {
  private fun no(): Nothing = error("StorageModule must not need the React bridge")
  override fun <T : JavaScriptModule> getJSModule(jsInterface: Class<T>): T = no()
  override fun <T : NativeModule> hasNativeModule(nativeModuleInterface: Class<T>): Boolean = no()
  override fun getNativeModules(): MutableCollection<NativeModule> = no()
  override fun <T : NativeModule> getNativeModule(nativeModuleInterface: Class<T>): T = no()
  override fun getNativeModule(name: String): NativeModule = no()
  override fun getCatalystInstance(): CatalystInstance = no()
  override fun hasActiveCatalystInstance(): Boolean = no()
  override fun hasActiveReactInstance(): Boolean = no()
  override fun hasCatalystInstance(): Boolean = no()
  override fun hasReactInstance(): Boolean = no()
  override fun destroy() = no()
  override fun handleException(e: Exception) = no()
  override fun isBridgeless(): Boolean = no()
  override fun getJavaScriptContextHolder(): JavaScriptContextHolder = no()
  override fun getJSCallInvokerHolder(): CallInvokerHolder = no()
  override fun getFabricUIManager(): UIManager = no()
  override fun getSourceURL(): String = no()
  override fun registerSegment(segmentId: Int, path: String, callback: Callback) = no()
}
