package com.innocorelabs.verbale

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
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
 * `StorageModule.backfillItems` from a process that has not loaded the native core.
 *
 * A CLASS OF ITS OWN for exactly the reason `StorageItemsTest` is one, and with ONE test for the
 * same reason: `NativeBridge.loaded` is a static flag, so once anything in a process has called
 * `ensureLoaded` nothing after it can tell whether the caller under test would have. `am instrument
 * -e class` gives each class its own process and `scripts/device-verify.sh` runs one invocation per
 * class, so this file starts with the flag unset — and `ItemSweepTest`, which loads the core in its
 * own helper before every test, cannot fail against a sweep that forgets to.
 *
 * This is not a hypothetical shape of bug. It is the bug Task 8 shipped and Task 8's review found:
 * `ensureItems` reached `nativeItems` through four frames with nothing on the path loading
 * libaudionotes.so, `BackfillTest` passed all nine of its tests against it, and the failure landed
 * precisely on the path the method existed for. The sweep is that path again and worse — nothing
 * loads the core at app start (`MainApplication.onCreate` calls `loadReactNative` and no more, and
 * every other `ensureLoaded` call site records, transcribes or generates), and this one runs on a
 * plain library focus, where the odds of somebody having recorded first are lower still.
 *
 * The catch in the module turns an UnsatisfiedLinkError into a rejected promise, so the symptom on
 * a real phone is not a crash: it is a library that never migrates, a worklist that says nothing is
 * outstanding, and no error anywhere a user or a log will see.
 */
@RunWith(AndroidJUnit4::class)
class StorageSweepTest {
  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

  /**
   * A meeting recorded before items existed, migrated by the sweep on a cold process.
   *
   * The assertion is the promise first — a rejection is what a real caller sees, and the store
   * swallows it — and then the items, so a promise that resolved without doing anything cannot
   * pass either. A small limit on purpose: the seeded meeting is the newest row in the database and
   * the sweep takes newest first, so one pass of five reaches it without walking this phone's
   * library on the way.
   */
  @Test fun theSweepMigratesWithoutTheCallerHavingLoadedTheCore() {
    // The core still cannot load without its downloaded dependency, and that is the module's
    // problem to report rather than this test's to pretend about.
    assumeTrue(
      "libonnxruntime.so not downloaded yet on this device",
      File(ModelCatalog.modelsDir(ctx), "libonnxruntime.so").exists(),
    )

    val db = AudioDb.get(ctx)
    val m = "test-storage-sweep-" + System.nanoTime()
    db.insertMeeting(m, "Sweep bridge test", System.currentTimeMillis(), "free", "/dev/null")
    try {
      db.replaceUtterancesJson(
        m,
        """[{"start_ms":61000,"end_ms":64000,"text":"I will send the report by Friday."}]""",
      )

      val promise = RecordingPromise()
      StorageModule(NoReactContext(ctx)).backfillItems(5.0, promise)

      assertNull(
        "the sweep failed at the JNI boundary: nothing on this path loads libaudionotes.so, so a " +
          "library focus on a cold start migrates nothing and reports it to no one",
        promise.rejection,
      )
      assertTrue("the promise neither resolved nor rejected", promise.resolved)
      assertTrue("the promise resolved without migrating anything", db.items(m).isNotEmpty())
    } finally {
      db.deleteMeeting(m)
    }
  }
}
