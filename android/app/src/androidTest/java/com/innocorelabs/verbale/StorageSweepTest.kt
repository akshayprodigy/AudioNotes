package com.innocorelabs.verbale

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.pipeline.StorageModule
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

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
 * THE SYMPTOM IS QUIETER THAN A REJECTION, and quieter than it is for `ensureItems`. There, the
 * UnsatisfiedLinkError reaches the method's own catch and arrives in JavaScript as a rejected
 * promise. Here it is raised inside `db.ensureItems(id)`, which the sweep wraps in `runCatching`
 * so that one bad meeting cannot freeze the whole library — so the throw is swallowed per meeting,
 * the loop finishes, and the promise RESOLVES, reporting a backlog that has not moved. The store
 * reads that as a pass which failed to shrink the backlog, breaks out without latching, and retries
 * on every focus for the life of the install: nothing migrates, nothing rejects, and no error
 * reaches a user or a log. That is an argument for calling ensureLoaded up front, not against it —
 * it is the one place on this path where the failure can still be made loud.
 *
 * Which is why the load-bearing assertion below is the item count and not the promise.
 */
@RunWith(AndroidJUnit4::class)
class StorageSweepTest {
  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

  /**
   * A meeting recorded before items existed, migrated by the sweep on a cold process.
   *
   * The rejection assertion is kept and is not the one that catches a missing `ensureLoaded` (see
   * the class note): it covers the failures that DO reach the outer catch — `AudioDb.get`, the
   * backlog query, and a genuinely absent libonnxruntime.so, which is the module's business to
   * report rather than this test's to pretend about. The items assertion is the one that fails when
   * the core was never loaded.
   *
   * A small limit on purpose, and it is not only about cost: the seeded meeting is the newest row
   * in the database and the sweep takes newest first, so one pass of five reaches it while stamping
   * at most four of this phone's real meetings on the way. That write is permanent — see
   * ItemSweepTest's note — and is the same one a Library focus would make a moment later.
   */
  @Test fun theSweepMigratesWithoutTheCallerHavingLoadedTheCore() {

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

      assertNull("the sweep rejected instead of migrating", promise.rejection)
      assertTrue("the promise neither resolved nor rejected", promise.resolved)
      assertTrue(
        "the sweep resolved and migrated nothing, which is what a missing NativeBridge.ensureLoaded " +
          "looks like from here: the UnsatisfiedLinkError is raised inside ensureItems, swallowed " +
          "by the per-meeting runCatching, and reported as a backlog that did not move — on a real " +
          "phone, a library that never migrates and never says so",
        db.items(m).isNotEmpty(),
      )
    } finally {
      db.deleteMeeting(m)
    }
  }
}
