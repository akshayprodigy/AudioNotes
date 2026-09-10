package com.innocorelabs.verbale

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ItemKey
import com.innocorelabs.verbale.data.ModelCatalog
import com.innocorelabs.verbale.pipeline.Minutes
import com.innocorelabs.verbale.pipeline.NativeBridge
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The migration a shipped install actually performs, and the one thing it cannot do.
 *
 * Every meeting already in somebody's library has `minutes` rows and, wherever they worked through
 * their actions, `action_done` rows keyed on a hash of the minute's TEXT. Items are new. So the
 * first time this build opens an old meeting it has to produce items from the transcript it
 * already has and move those ticks onto them — and if the move is wrong, nothing says so: the
 * meeting opens, the items look right, and a list somebody had finished is simply unticked again.
 *
 * Three properties carry that, and each has a test because each fails silently:
 *
 *  - **The tick lands on the right item.** The key is computed from text on both sides, so the two
 *    sides have to agree about the text character for character. They agree today because
 *    `Minutes.extract` and `Minutes.extractItems` are the same rules over the same turns — which
 *    is a fact about the C++ core, not a guarantee anybody wrote down, so
 *    [aTickOnAShippedMinuteLandsOnTheItemThatReplacesIt] takes the minute the OLD path produced and
 *    ticks that, rather than a string this file made up. The day the two diverge, every tick in
 *    every existing library is lost, and this is what notices.
 *  - **The anchor is the moment it was said.** The whole point of running the rules again rather
 *    than converting `minutes` rows in place: a `minutes` row has no timings, and an item that
 *    anchors at 0 sends Task 10's player to the top of the meeting.
 *  - **Running it twice changes nothing.** [ensureItems] derives "has this been migrated" from the
 *    data rather than from a flag (see its KDoc for why a flag would be wrong), so a second pass is
 *    routine rather than exceptional and must be a no-op.
 *
 * And the limitation, pinned deliberately in [aTickWhoseTextDriftedIsNotCarried]: a tick whose text
 * no longer hashes the same is NOT recovered, and cannot be. That population is real — it is why
 * `item_done` exists at all — so the test exists to stop a later reader believing it was handled.
 *
 * No audio is involved anywhere here. The rule pass is pure text over stored utterances, which is
 * what makes migrating a whole library affordable and what lets a meeting whose recording was
 * deleted still gain its transcript links. The native core is needed only because the rules live
 * in C++; the models are not, so this runs on a phone that has never downloaded one.
 */
@RunWith(AndroidJUnit4::class)
class BackfillTest {
  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
  private val db = AudioDb.get(ctx)

  /**
   * Rules are pure string work and need no model — but libaudionotes.so carries a DT_NEEDED on
   * libonnxruntime.so and cannot load without it. Same assumption MinutesParityTest makes.
   */
  private fun ensureCore() {
    val ort = File(ModelCatalog.modelsDir(ctx), "libonnxruntime.so")
    assumeTrue("libonnxruntime.so not downloaded yet on this device", ort.exists())
    NativeBridge.ensureLoaded(ctx)
  }

  /**
   * One turn that the action rule fires on and one the decision rule fires on, at known times.
   *
   * The times are minutes in, not zero, because "anchored at the moment it was said" and "anchored
   * at the start of the meeting" are the same assertion when the moment IS the start.
   */
  private val TRANSCRIPT = """[
    {"start_ms":61000,"end_ms":64000,"text":"We agreed to ship on Monday."},
    {"start_ms":125000,"end_ms":129000,"text":"I will send the report by Friday."}
  ]"""

  /** Runs [body] against a meeting of its own and takes the meeting away afterwards. */
  private fun inAMeeting(withTranscript: Boolean = true, body: (String) -> Unit) {
    ensureCore()
    val m = "test-backfill-" + System.nanoTime()
    db.insertMeeting(m, "Backfill test", System.currentTimeMillis(), "free", "/dev/null")
    try {
      if (withTranscript) db.replaceUtterancesJson(m, TRANSCRIPT)
      body(m)
    } finally {
      db.deleteMeeting(m)
    }
  }

  /**
   * Bound DML, through the path JS already uses — see the same helper in ItemsDbTest for why it
   * is `rawQueryJson` and not the narrower-sounding `AudioDb.exec`.
   */
  private fun exec(sql: String, vararg args: String) = db.rawQueryJson(sql, arrayOf<String?>(*args))

  /**
   * The state a shipped build leaves behind: rule minutes on disk, and a tick against one of them.
   * Returns the minute content that was ticked.
   */
  private fun tickAnActionTheOldWay(meetingId: String): String {
    val minutes = Minutes.extract(db.utterances(meetingId), db.speakers(meetingId))
    val action = minutes.first { it.kind == "action" }
    db.replaceMinutes(meetingId, "rule", minutes)
    exec(
      "INSERT INTO action_done(meeting_id,item_key,done_at) VALUES(?,?,?)",
      meetingId, ItemKey.of(action.content), "1",
    )
    return action.content
  }

  // ---- The migration ---------------------------------------------------------------------

  /**
   * A tick recorded against a `minutes` row is still a tick after the item replaces it.
   *
   * The ticked text is taken from `Minutes.extract` rather than written out here on purpose: that
   * is literally the string a shipped build stored and hashed, so this pins the agreement between
   * the two extractors as well as the migration itself. Hard-coding the expected sentence would
   * pass on a build where the two had drifted — which is the build where every tick is lost.
   */
  @Test fun aTickOnAShippedMinuteLandsOnTheItemThatReplacesIt() {
    inAMeeting { m ->
      val ticked = tickAnActionTheOldWay(m)

      val written = db.backfillItems(m)

      assertTrue("the rules produced no items from a transcript that has two", written >= 2)
      val action = db.items(m).firstOrNull { it.kind == "action" }
      assertNotNull("no action item came out of a transcript containing one", action)
      assertEquals(
        "the item text no longer matches the minute the tick was keyed on, so no tick can move",
        ticked, action!!.text,
      )
      assertTrue(
        "somebody's finished action came back unticked after the migration",
        db.doneItemIds(m).contains(action.id),
      )
    }
  }

  /**
   * A migrated tick keeps the day it was ticked, not the day it was migrated.
   *
   * The date is forced to an impossible one rather than captured and compared, for the reason
   * ItemsDbTest's `created_at` test spells out: an implementation that stamps `now` passes a
   * capture-and-compare whenever both writes land in the same millisecond, which on a phone is
   * most runs. A tick dated 1970 cannot be re-stamped by accident.
   *
   * Lost, if it breaks: everybody's whole worklist reads as finished this morning the first time
   * they open the app after updating, and the real dates were only ever in `action_done`.
   */
  @Test fun aMigratedTickKeepsTheDayItWasActuallyTicked() {
    inAMeeting { m ->
      val ticked = tickAnActionTheOldWay(m)
      exec(
        "UPDATE action_done SET done_at=86400000 WHERE meeting_id=? AND item_key=?",
        m, ItemKey.of(ticked),
      )

      db.backfillItems(m)

      val rows = JSONArray(
        db.rawQueryJson("SELECT done_at FROM item_done WHERE meeting_id=?", arrayOf<String?>(m)),
      )
      assertEquals("the tick was lost, or spread onto items nobody ticked", 1, rows.length())
      assertEquals(
        "the tick was re-dated to the day the migration ran",
        86400000L, rows.getJSONObject(0).getLong("done_at"),
      )
    }
  }

  /**
   * The item is anchored where it was said, not at the start of the meeting.
   *
   * This is the reason the migration re-runs the rules over the transcript instead of converting
   * `minutes` rows: those rows carry no timings at all, so a conversion would anchor everything at
   * 0 and every migrated item would send the player to the top of the meeting.
   */
  @Test fun aBackfilledItemIsAnchoredAtTheTurnThatSaidIt() {
    inAMeeting { m ->
      db.backfillItems(m)
      val action = db.items(m).first { it.kind == "action" }
      assertEquals("the action anchored somewhere other than the turn it was said in", 125000L, action.anchorStartMs)
      assertEquals(129000L, action.anchorEndMs)
      val decision = db.items(m).first { it.kind == "decision" }
      assertEquals(61000L, decision.anchorStartMs)
    }
  }

  /**
   * Twice is the same as once.
   *
   * [AudioDb.ensureItems] has no "migrated" flag to consult, so a re-run is the normal case rather
   * than an accident. Ids are what a tick, a review and a hand edit all hang off; re-minting them
   * would strand every one of those against a row that no longer exists.
   */
  @Test fun runningTheBackfillTwiceKeepsEveryId() {
    inAMeeting { m ->
      db.backfillItems(m)
      val first = db.items(m).map { it.id }
      assertTrue("nothing to compare — the first pass produced no items", first.isNotEmpty())

      db.backfillItems(m)

      assertEquals("the second pass re-minted the ids everything else hangs off", first, db.items(m).map { it.id })
    }
  }

  /**
   * A tick the migration cannot recover, pinned so nobody later believes it can.
   *
   * `action_done`'s key is a hash of the text, so a tick can only be found while the text still
   * hashes the same. Where the shipped minute and the item extracted today differ by so much as a
   * word — a re-recognition, a rules change, an edit — the key moved with it and the tick is
   * unreachable from either side. That is the population `item_done` exists for, and the honest
   * position is that this migration is the LAST chance to catch a tick, not a way to recover one
   * already lost. If this test ever starts failing because the tick WAS carried, something is
   * matching on something other than the key, and it is matching by luck.
   */
  @Test fun aTickWhoseTextDriftedIsNotCarried() {
    inAMeeting { m ->
      val ticked = tickAnActionTheOldWay(m)
      // One word different: the same action to a person, a different key to a hash.
      exec("DELETE FROM action_done WHERE meeting_id=?", m)
      exec(
        "INSERT INTO action_done(meeting_id,item_key,done_at) VALUES(?,?,?)",
        m, ItemKey.of(ticked.replace("report", "summary")), "1",
      )

      db.backfillItems(m)

      assertTrue(
        "a tick was carried onto an item whose text hashes differently — matched by something " +
          "other than the key, which means it can match the WRONG item too",
        db.doneItemIds(m).isEmpty(),
      )
    }
  }

  // ---- Meetings with no transcript -------------------------------------------------------

  /**
   * A meeting with no utterances backfills to nothing, and takes nothing with it.
   *
   * `backfillItems` returns before it reaches `replaceItems`, and that early return is the whole
   * test. Without it the rules are handed no turns, return no items, and `replaceItems` is called
   * with an empty list — at which point the reconciler has nothing to match anything against and
   * rule 4 deletes every untouched row in the meeting.
   *
   * A meeting can genuinely be in this state. `replaceUtterancesJson` deletes the old turns before
   * writing the new ones, so a re-recognition that comes back with nothing — an all-silence
   * recording, or the language refusal the Galaxy A07 produced on plain English — leaves a meeting
   * whose items are still there and whose transcript is not.
   *
   * The seeded row is a RULES row on purpose. A user-typed one proves nothing here: `Reconciler`
   * rule 1 sets `gen_version='user'` aside before matching, so it survives an empty reprocess
   * whether the early return exists or not — measured, and it is why the first version of this
   * test could not fail against the defect it names.
   */
  @Test fun aMeetingWithNoUtterancesKeepsTheItemsItAlreadyHas() {
    inAMeeting(withTranscript = false) { m ->
      db.replaceItems(
        m, Minutes.RULES_GEN,
        listOf(
          Minutes.Item(
            "action", "Ring the venue back — Priya",
            listOf(Minutes.Source(null, 30_000L, 34_000L, 0, 27)), 30_000L, 34_000L,
          ),
        ),
      )
      val before = db.items(m).map { it.id }
      assertEquals("precondition: one item to lose", 1, before.size)

      val written = db.backfillItems(m)

      assertEquals("a meeting with no transcript cannot have produced items", 0, written)
      assertEquals(
        "the backfill ran the rules over no turns and deleted the items already there",
        before, db.items(m).map { it.id },
      )
    }
  }

  // ---- ensureItems, the trigger ----------------------------------------------------------

  /**
   * The trigger produces items for a meeting recorded before they existed.
   *
   * Task 9 is what calls this from the meeting screen; until then it is reachable only from
   * `StorageModule.ensureItems`, which is why it is pinned here rather than left to that task.
   */
  @Test fun ensureItemsMigratesAMeetingThatHasNone() {
    inAMeeting { m ->
      assertTrue("precondition: the meeting starts with no items", db.items(m).isEmpty())

      db.ensureItems(m)

      assertTrue("a pre-items meeting was opened and stayed empty", db.items(m).isNotEmpty())
    }
  }

  /**
   * The trigger leaves a meeting that already has items alone.
   *
   * Not a performance point. `replaceItems` runs the reconciler, which deletes an untouched row
   * that the rules no longer produce — so re-running the migration on every open would quietly
   * re-extract over the top of whatever the meeting had become. The row's text is changed by hand
   * first because that is the difference a re-run would destroy and an id comparison would not
   * see: the reconciler matches on the anchor and would hand the same id back carrying this run's
   * text.
   */
  @Test fun ensureItemsDoesNotReExtractOverAMeetingThatAlreadyHasItems() {
    inAMeeting { m ->
      db.backfillItems(m)
      val id = db.items(m).first { it.kind == "action" }.id
      exec("UPDATE items SET text='Send the deck to Priya instead' WHERE id=?", id)

      db.ensureItems(m)

      assertEquals(
        "the migration ran a second time and re-extracted over the meeting's own row",
        "Send the deck to Priya instead", db.items(m).first { it.id == id }.text,
      )
    }
  }

  /** A meeting with nothing to migrate is not a failure — it is most of a fresh install. */
  @Test fun ensureItemsOnAMeetingWithNoTranscriptDoesNothing() {
    inAMeeting(withTranscript = false) { m ->
      db.ensureItems(m)
      assertTrue("items appeared for a meeting with no transcript to make them from", db.items(m).isEmpty())
    }
  }
}
