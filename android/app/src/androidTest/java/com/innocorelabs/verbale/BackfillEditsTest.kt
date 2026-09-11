package com.innocorelabs.verbale

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ItemKey
import com.innocorelabs.verbale.data.ModelCatalog
import com.innocorelabs.verbale.pipeline.Minutes
import com.innocorelabs.verbale.pipeline.NativeBridge
import com.innocorelabs.verbale.pipeline.StorageModule
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Every correction anybody has ever written, moved onto the item it belongs to.
 *
 * THE FAILURE THIS EXISTS TO CATCH IS TOTAL AND SILENT. `edits` rows are keyed
 * `target_kind='minute'`, `target_key=ItemKey.of(<the stored minutes content>)` — that is what every
 * shipped build wrote and it is the only copy of a person's own words about their meeting. Task 11
 * switches the reader to `target_kind='item'` keyed on `items.id`. `edits` carries a foreign key to
 * `meetings` and NONE to `items`, and nothing anywhere cleans up orphans, so a switch made without
 * this migration compiles, runs, raises nothing, and simply returns an empty join: every correction
 * in every install, gone, with no error and nothing on screen to notice.
 *
 * THE IDENTITY IT RESTS ON is the same one `backfillItems` bets every existing tick on:
 * `ItemKey.of(item.text)` reproduces `ItemKey.of(minute.content)`, because `Minutes.extract` and
 * `Minutes.extractItems` are the same rules over the same turns. It does NOT rest on the two
 * strings being equal — they are not always, since `extractItems` asciifies whitespace before
 * splitting sentences and `extractMinutes` does not, so a non-breaking space survives into the
 * minute and becomes a plain space in the item. `ItemKey` collapses whitespace runs before hashing,
 * which is why the key still matches. So the seeded correction here is keyed on the string
 * `Minutes.extract` REALLY produced rather than on a literal, exactly as `BackfillTest` ticks a
 * real minute: a literal would pass on the build where the two extractors had drifted, which is
 * the build where every correction is lost.
 *
 * WHAT THE MOVE BUYS, beyond not losing anything. An id survives a re-wording and a text hash does
 * not, so a correction now outlives a reprocess that changes one word of the item it corrects —
 * and it finally makes `StoredItem.touched` true for a corrected row, which is what stops
 * `Reconciler` rule 4 deleting somebody's own words when the rules stop extracting the line.
 *
 * TWO ENTRY POINTS, because one cannot reach every meeting that needs it — see
 * [aCorrectionIsCarriedForAMeetingTheMigrationWillNeverVisitAgain].
 */
@RunWith(AndroidJUnit4::class)
class BackfillEditsTest {
  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
  private val db = AudioDb.get(ctx)

  /** Same assumption as BackfillTest: the rules are pure text, but the .so has a DT_NEEDED. */
  private fun ensureCore() {
    val ort = File(ModelCatalog.modelsDir(ctx), "libonnxruntime.so")
    assumeTrue("libonnxruntime.so not downloaded yet on this device", ort.exists())
    NativeBridge.ensureLoaded(ctx)
  }

  private val TRANSCRIPT = """[
    {"start_ms":61000,"end_ms":64000,"text":"We agreed to ship on Monday."},
    {"start_ms":125000,"end_ms":129000,"text":"I will send the report by Friday."}
  ]"""

  private fun inAMeeting(body: (String) -> Unit) {
    ensureCore()
    val m = "test-carry-edits-" + System.nanoTime()
    db.insertMeeting(m, "Carry edits test", System.currentTimeMillis(), "free", "/dev/null")
    try {
      db.replaceUtterancesJson(m, TRANSCRIPT)
      body(m)
    } finally {
      db.deleteMeeting(m)
    }
  }

  private fun exec(sql: String, vararg args: String) = db.rawQueryJson(sql, arrayOf<String?>(*args))

  private fun editRows(meetingId: String): JSONArray = JSONArray(
    db.rawQueryJson(
      "SELECT target_kind AS kind,target_key AS key,content,edited_at AS at FROM edits " +
        "WHERE meeting_id=? ORDER BY target_kind",
      arrayOf<String?>(meetingId),
    ),
  )

  private val CORRECTION = "Priya to send the Q3 report by Friday — Priya"

  /**
   * The state a shipped build leaves behind: rule minutes on disk, and a correction of one of them.
   *
   * Returns the minute content that was corrected — taken from `Minutes.extract` rather than
   * written out here, for the reason the class doc gives.
   */
  private fun correctAnActionTheOldWay(meetingId: String): String {
    val minutes = Minutes.extract(db.utterances(meetingId), db.speakers(meetingId))
    val action = minutes.first { it.kind == "action" }
    db.replaceMinutes(meetingId, "rule", minutes)
    db.putEdit(meetingId, "minute", ItemKey.of(action.content), CORRECTION)
    return action.content
  }

  // ---- The carry ---------------------------------------------------------------------------

  /**
   * A correction written against a `minutes` row is still a correction after the item replaces it.
   *
   * The single assertion this whole file exists for. If it fails, every person who has ever fixed
   * a word in their own minutes loses it, and the only sign is that the line reads as the app
   * wrote it.
   */
  @Test fun aCorrectionOnAShippedMinuteIsFoundOnTheItemThatReplacesIt() {
    inAMeeting { m ->
      val corrected = correctAnActionTheOldWay(m)

      db.backfillItems(m)

      val action = db.items(m).firstOrNull { it.kind == "action" }
      assertTrue("no action item came out of a transcript containing one", action != null)
      assertEquals(
        "the item text no longer matches the minute the correction was keyed on",
        corrected, action!!.text,
      )
      val rows = editRows(m)
      assertEquals("the correction was duplicated or dropped", 1, rows.length())
      assertEquals(
        "the correction is still keyed on the minute, so nothing will ever find it again",
        "item", rows.getJSONObject(0).getString("kind"),
      )
      assertEquals(action.id, rows.getJSONObject(0).getString("key"))
      assertEquals(CORRECTION, rows.getJSONObject(0).getString("content"))
    }
  }

  /**
   * A carried correction keeps the day it was written, not the day it was migrated.
   *
   * Forced to an impossible date rather than captured and compared, for the reason
   * `BackfillTest.aMigratedTickKeepsTheDayItWasActuallyTicked` spells out: an implementation that
   * stamps `now` passes a capture-and-compare whenever both writes land in the same millisecond,
   * which on a phone is most runs.
   */
  @Test fun aCarriedCorrectionKeepsTheDayItWasWritten() {
    inAMeeting { m ->
      val corrected = correctAnActionTheOldWay(m)
      exec(
        "UPDATE edits SET edited_at=86400000 WHERE meeting_id=? AND target_kind='minute' AND target_key=?",
        m, ItemKey.of(corrected),
      )

      db.backfillItems(m)

      val rows = editRows(m)
      assertEquals(1, rows.length())
      assertEquals(
        "the correction was re-dated to the day the migration ran",
        86400000L, rows.getJSONObject(0).getLong("at"),
      )
    }
  }

  /**
   * THE TRAP THE PLAN'S ONE-LINE INSTRUCTION WALKS INTO.
   *
   * `items_migrated_at` is stamped on every meeting the Task 8b sweep has already processed, and
   * `ensureItems` never calls `backfillItems` for one again — so a carry that lived ONLY inside
   * `backfillItems` would never run for the meetings most likely to be carrying old corrections.
   * The same is true of every meeting the current pipeline wrote items for directly, which carries
   * no marker and is excluded by `items().isEmpty()` instead.
   *
   * So the bridge entry point carries as well, and this drives the bridge rather than `AudioDb`
   * for that reason: it is the call every reader of a meeting passes through — MeetingScreen
   * awaits it before it reads `edits`, and the export is only reachable from a meeting screen that
   * has. Asserting through it keeps the test true wherever the carry is later moved to.
   */
  @Test fun aCorrectionIsCarriedForAMeetingTheMigrationWillNeverVisitAgain() {
    inAMeeting { m ->
      // Migrate it first, so it is stamped and `ensureItems` is finished with it forever...
      db.backfillItems(m)
      val action = db.items(m).first { it.kind == "action" }
      // ...and only THEN does a correction keyed the old way turn up, exactly as it does on a
      // phone whose library was swept before this build was installed.
      db.putEdit(m, "minute", ItemKey.of(action.text), CORRECTION)

      val promise = RecordingPromise()
      StorageModule(NoReactContext(ctx)).ensureItems(m, promise)

      assertNull("the bridge rejected", promise.rejection)
      val rows = editRows(m)
      assertEquals(1, rows.length())
      assertEquals(
        "a meeting already marked migrated kept its correction on a key nothing reads",
        "item", rows.getJSONObject(0).getString("kind"),
      )
      assertEquals(action.id, rows.getJSONObject(0).getString("key"))
    }
  }

  /**
   * A correction the carry cannot place is LEFT ALONE — not deleted, and that is a decision.
   *
   * There are three ways to have a `minute`-keyed correction that matches no item, and only one of
   * them is a genuine orphan:
   *
   *  - a meeting whose migration has not run yet, which has no items to match against and gets
   *    them on a later open;
   *  - a correction whose minute the rules no longer produce at all.
   *
   * (A row somebody TYPED was a third until Task 12 gave it an item of its own, and note the order
   * that forced at both call sites: `carryUserMinutesOntoItems` runs BEFORE this, so a correction
   * on such a row has an item to find rather than being left on a key nothing reads.)
   *
   * Deleting on a failure to match would destroy the first along with the second, and the second
   * is the one case where the row is harmless: it is a few dozen bytes, `edits` has no orphan
   * cleanup for any other kind either, and a correction is the only thing in this database that
   * cannot be recomputed from anything. Nothing is deleted; the carry only ever MOVES a row it has
   * found a home for.
   */
  @Test fun aCorrectionWhoseItemIsGoneIsNotDeleted() {
    inAMeeting { m ->
      db.backfillItems(m)
      db.putEdit(m, "minute", ItemKey.of("Something nobody ever said in this meeting"), "Kept")

      assertEquals(
        "the carry reported work it did not do — it contracts the number of rows REWRITTEN, and " +
          "nothing here can be placed on an item",
        0, db.carryEditsOntoItems(m),
      )

      val rows = editRows(m)
      assertEquals("somebody's own words were deleted for not matching", 1, rows.length())
      assertEquals("minute", rows.getJSONObject(0).getString("kind"))
      assertEquals("Kept", rows.getJSONObject(0).getString("content"))
    }
  }

  /**
   * Twice is the same as once — and the second pass actually runs.
   *
   * The carry is called on every open, so a re-run is the ordinary case rather than an accident.
   * The first version of this test seeded only a CARRYABLE correction, so by the second pass there
   * was nothing left keyed `minute`, the `pending.isEmpty()` early return fired, and the loop it
   * claims to be testing was never entered — it asserted the idempotence of a function that had
   * already returned. A correction that can NEVER be carried is seeded alongside, which is not a
   * contrivance: any meeting whose migration has not run keeps `minute` keys, so this is the
   * state of every meeting somebody has typed a decision into.
   *
   * BE PRECISE ABOUT WHAT THE SECOND PASS NOW REACHES, because the obvious reading is wrong. It
   * gets past `pending.isEmpty()` and runs the matching — `rows.mapNotNull` over every item — and
   * then stops at `moves.isEmpty()`. The write loop inside the transaction is still never entered
   * twice, and no test in this file enters it twice, because there is no way to: a carried row is
   * gone. What this pins is the matching pass and the reported count, which is what "a re-run finds
   * nothing" actually means.
   */
  @Test fun runningTheCarryTwiceChangesNothing() {
    inAMeeting { m ->
      correctAnActionTheOldWay(m)
      // Stands in for a hand-typed row: a correction with no item that will ever match it, so
      // `pending` is still non-empty on the second pass and the MATCHING runs — see the docstring
      // for what that does and does not reach.
      db.putEdit(m, "minute", ItemKey.of("A decision nobody ever extracted"), "Typed by hand")
      db.backfillItems(m)
      val first = editRows(m).toString()
      assertEquals("precondition: one carried and one left behind", 2, editRows(m).length())

      assertEquals(
        "a second pass moved something the first should have finished",
        0, db.carryEditsOntoItems(m),
      )
      assertEquals(first, editRows(m).toString())
    }
  }

  /**
   * A correction written against the ITEM is never overwritten by an older one from the minute.
   *
   * The item-keyed row is both newer and more specific — it was written by this build, against
   * this row's identity — so it wins, and the stale minute-keyed row goes rather than being left
   * to resurface the next time somebody reverts.
   */
  @Test fun aCorrectionAlreadyWrittenAgainstTheItemWins() {
    inAMeeting { m ->
      val corrected = correctAnActionTheOldWay(m)
      db.backfillItems(m)
      val action = db.items(m).first { it.kind == "action" }
      db.putEdit(m, "item", action.id, "What the user typed most recently")
      db.putEdit(m, "minute", ItemKey.of(corrected), CORRECTION)

      assertEquals(
        "the carry reported a count other than the rows it rewrote",
        1, db.carryEditsOntoItems(m),
      )

      val rows = editRows(m)
      assertEquals("the stale minute row was left behind to come back on a revert", 1, rows.length())
      assertEquals("item", rows.getJSONObject(0).getString("kind"))
      assertEquals(
        "an older correction was written over the one the user made last",
        "What the user typed most recently", rows.getJSONObject(0).getString("content"),
      )
    }
  }

  /**
   * A corrected item is now PROTECTED from a rule pass that stops extracting it.
   *
   * `StoredItem.touched` has always counted a hand correction as engagement, and the join that
   * asks was written for `target_kind='item'` — so until this migration it matched nothing in
   * production and a corrected row read as untouched. `Reconciler` rule 4 deletes an untouched row
   * the rules no longer produce, which means a person's own words could be swept away by a
   * reprocess with nothing to show for it. The empty reprocess below is that exact event.
   *
   * NOT the same test as `ItemsDbTest.aHandEditedItemSurvivesAReprocessThatNoLongerExtractsIt`,
   * which seeds an `item`-keyed row by hand and has always passed. What was missing was anything
   * in production that WROTE one; this starts from a correction in the shape a shipped build left
   * behind and asserts the whole chain, which is the only version of the claim that was ever in
   * doubt.
   */
  @Test fun aCorrectedItemIsProtectedFromARuleThatNoLongerExtractsIt() {
    inAMeeting { m ->
      correctAnActionTheOldWay(m)
      db.backfillItems(m)
      val action = db.items(m).first { it.kind == "action" }
      assertTrue("a corrected item still reads as untouched", action.touched)

      // A reprocess whose rules no longer produce this line at all.
      db.replaceItems(m, Minutes.RULES_GEN, emptyList())

      assertEquals(
        "the reprocess deleted an item somebody had rewritten by hand",
        listOf(action.id), db.items(m).map { it.id },
      )
    }
  }
}
