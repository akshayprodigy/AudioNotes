package com.innocorelabs.verbale

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
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
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ModelCatalog
import com.innocorelabs.verbale.pipeline.StorageModule
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * `StorageModule.ensureItems` from a process that has not loaded the native core.
 *
 * A CLASS OF ITS OWN, and that is the entire mechanism. `NativeBridge.loaded` is a static flag, so
 * once anything in a process has called `ensureLoaded` nothing afterwards can tell whether the
 * caller under test would have. `BackfillTest` loads the core in its own helper before every test,
 * which means it can never fail against a migration path that forgets to — and it did not: the
 * bridge method reached `nativeItems` through three layers with nothing on the way loading
 * libaudionotes.so, and every one of BackfillTest's nine tests passed anyway.
 *
 * `am instrument -e class` gives each class its own process, and `scripts/device-verify.sh` runs
 * one invocation per class, so this file starts with the flag unset. ONE test, for the same
 * reason — a second one that happened to run first would load the core and disarm this one.
 *
 * What makes the omission worth a whole file: nothing loads the core at app start.
 * `MainApplication.onCreate` calls `loadReactNative` and no more, and the other four
 * `ensureLoaded` call sites are all on paths that record, transcribe or generate. So the failure
 * lands precisely on the path this method exists for — a cold start where somebody opens an old
 * meeting and records nothing — and `ensureItems` catches `Throwable`, so an UnsatisfiedLinkError
 * arrives in JavaScript as a rejected promise and a meeting that quietly never migrates.
 */
@RunWith(AndroidJUnit4::class)
class StorageItemsTest {
  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

  /** Records whichever of the eleven Promise methods the module actually calls. */
  private class Recording : Promise {
    var resolved = false
    var rejection: Throwable? = null
    var rejectionCode: String? = null

    private fun fail(code: String?, t: Throwable?) {
      rejectionCode = code
      rejection = t ?: RuntimeException(code ?: "rejected")
    }

    override fun resolve(value: Any?) { resolved = true }
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
   * bridge — modules, the catalyst instance, the JS call invoker. `StorageModule` uses its context
   * as a plain `Context` and nothing else, so every one of them throws rather than returning a
   * plausible nothing: if this method ever starts needing the bridge, the test says so instead of
   * quietly testing a different object than production uses.
   */
  private class NoReactInstance(base: Context) : ReactApplicationContext(base) {
    private fun no(): Nothing = error("StorageModule.ensureItems must not need the React bridge")
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

  /**
   * A meeting recorded before items existed, opened through the bridge.
   *
   * The assertion is the promise, not the items: a rejection is exactly what a real caller would
   * see, and it is the difference between "this migration ran" and "this migration reported an
   * error nobody looks at". The item count is checked afterwards so a promise that resolved
   * without doing anything cannot pass either.
   */
  @Test fun ensureItemsMigratesAMeetingWithoutTheCallerHavingLoadedTheCore() {
    // The core still cannot load without its downloaded dependency, and that is the module's
    // problem to report rather than this test's to pretend about.
    assumeTrue(
      "libonnxruntime.so not downloaded yet on this device",
      File(ModelCatalog.modelsDir(ctx), "libonnxruntime.so").exists(),
    )

    val db = AudioDb.get(ctx)
    val m = "test-storage-items-" + System.nanoTime()
    db.insertMeeting(m, "Storage bridge test", System.currentTimeMillis(), "free", "/dev/null")
    try {
      db.replaceUtterancesJson(
        m,
        """[{"start_ms":61000,"end_ms":64000,"text":"I will send the report by Friday."}]""",
      )

      val promise = Recording()
      StorageModule(NoReactInstance(ctx)).ensureItems(m, promise)

      assertNull(
        "the migration failed at the JNI boundary: nothing on this path loads libaudionotes.so, " +
          "so a meeting opened on a cold start silently never gets its items",
        promise.rejection,
      )
      assertTrue("the promise neither resolved nor rejected", promise.resolved)
      assertTrue("the promise resolved without migrating anything", db.items(m).isNotEmpty())
    } finally {
      db.deleteMeeting(m)
    }
  }
}
