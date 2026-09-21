package com.innocorelabs.verbale

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ItemKey
import com.innocorelabs.verbale.pipeline.Minutes
import com.innocorelabs.verbale.pipeline.NativeBridge
import com.innocorelabs.verbale.pipeline.StorageModule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The library-wide half of the migration: which meetings the sweep picks up, and when it stops.
 *
 * `BackfillTest` covers what happens to ONE meeting — the items it produces, the ticks it carries,
 * the tick it cannot. This file covers the question that only exists once the migration is driven
 * across a whole library, and it is a different question with a different answer:
 *
 * **"Has this meeting got items?" cannot mean "has this meeting been migrated."** A transcript can
 * legitimately contain no decisions, no actions and no questions — small talk, a voice note, a
 * meeting that was all numbers — and the rules correctly produce ZERO items for it. Such a meeting
 * has a transcript and no items forever, which is byte-for-byte the state of a meeting nothing has
 * migrated yet. Under Task 8's per-meeting trigger that cost a wasted rule pass each time somebody
 * opened it: milliseconds, invisible. Under a sweep it is fatal — the meeting comes back in every
 * batch for the rest of the install's life, the backlog never reaches zero, the store never
 * latches, and every single library focus spends its whole pass budget re-extracting meetings that
 * were finished the first time. `meetings.items_migrated_at` is the answer, and
 * [aMeetingThatYieldsNoItemsIsSweptOnceAndNeverAgain] is the test that fails without it.
 *
 * `unindexedMeetings` needs no such column, and the difference is worth stating rather than
 * inferring: every meeting with a transcript produces at least one search-index row, so for search
 * "are the rows there" IS the question. Items are the case where it is not.
 *
 * WHAT [theSweepDrainsTheBacklogAndCarriesTheTicksItFinds] DOES TO THIS PHONE: it drains the whole
 * library, this device's real meetings included, because that is what the sweep is — a global
 * driver with no meeting-id parameter, and a `remaining` of zero is a claim about the database and
 * not about three seeded rows. Nothing is destroyed by it; those meetings gain exactly the items
 * the next library focus would have given them anyway.
 *
 * It is PERMANENT, though, and that is worth saying plainly rather than leaving to be inferred:
 * every real meeting it reaches is stamped with `meetings.items_migrated_at`, and
 * [removeSeededMeetings] deletes only the meetings this file created, so none of that is undone
 * when the run finishes. The same is true of `StorageSweepTest`, at a smaller scale. Running these
 * tests migrates the phone.
 *
 * No audio anywhere here, as in BackfillTest: the rule pass is pure text over stored utterances,
 * so this runs on a phone that has never downloaded a model. The native core still has to load,
 * which is the one thing it does need.
 */
@RunWith(AndroidJUnit4::class)
class ItemSweepTest {
  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
  private val db = AudioDb.get(ctx)
  private val created = ArrayList<String>()

  /**
   * Rules are pure string work and need no model — but libaudionotes.so carries a DT_NEEDED on
   * libonnxruntime.so and cannot load without it. Same assumption BackfillTest makes.
   */
  private fun ensureCore() {
    NativeBridge.ensureLoaded(ctx)
  }

  /** One turn the action rule fires on and one the decision rule fires on, at known times. */
  private val WITH_ITEMS = """[
    {"start_ms":61000,"end_ms":64000,"text":"We agreed to ship on Monday."},
    {"start_ms":125000,"end_ms":129000,"text":"I will send the report by Friday."}
  ]"""

  /**
   * A real transcript that yields NOTHING, which is the population this whole file exists for.
   *
   * Every rule has to miss: no question mark and no leading question word, none of the decision
   * phrases, none of the obligation or first-person or assignment phrases, and no leading
   * imperative verb. That is not a contrived string — it is what most of a voice note, a phone
   * call or the first two minutes of any meeting looks like.
   */
  private val WITHOUT_ITEMS = """[
    {"start_ms":15000,"end_ms":18000,"text":"The rain on the roof was extremely loud last night."},
    {"start_ms":42000,"end_ms":45000,"text":"My cat slept straight through the whole thing."}
  ]"""

  /** A limit no real library reaches, so "is it in the backlog" is never "is it in the first 25". */
  private val ALL = 10_000

  private fun aMeeting(transcript: String): String {
    val m = "test-sweep-" + System.nanoTime()
    db.insertMeeting(m, "Sweep test", System.currentTimeMillis(), "free", "/dev/null")
    created.add(m)
    db.replaceUtterancesJson(m, transcript)
    return m
  }

  @After fun removeSeededMeetings() {
    for (m in created) runCatching { db.deleteMeeting(m) }
    created.clear()
  }

  /** The state a shipped build leaves behind: rule minutes on disk, and a tick against one. */
  private fun tickAnActionTheOldWay(meetingId: String): String {
    val minutes = Minutes.extract(db.utterances(meetingId), db.speakers(meetingId))
    val action = minutes.first { it.kind == "action" }
    db.replaceMinutes(meetingId, "rule", minutes)
    db.rawQueryJson(
      "INSERT INTO action_done(meeting_id,item_key,done_at) VALUES(?,?,?)",
      arrayOf<String?>(meetingId, ItemKey.of(action.content), "1"),
    )
    return action.content
  }

  /** One pass of the sweep, through the bridge method the app actually calls. */
  private fun sweep(limit: Int): Int {
    val promise = RecordingPromise()
    StorageModule(NoReactContext(ctx)).backfillItems(limit.toDouble(), promise)
    assertNull("the sweep rejected instead of migrating", promise.rejection)
    assertTrue("the sweep neither resolved nor rejected", promise.resolved)
    return (promise.value as Double).toInt()
  }

  // ---- Which meetings are in the backlog --------------------------------------------------

  /**
   * THE test this task turns on: a meeting whose transcript yields no items is swept ONCE.
   *
   * Without the marker the guard is "has a transcript, has no items", which is permanently true
   * for this meeting — so it is handed back by every pass forever, the backlog never drains, and
   * the sweep re-extracts a finished meeting on every library focus for the life of the install.
   * The assertion is deliberately on the SECOND read rather than on the column: what has to be
   * true is that the backlog shrank, and reading `items_migrated_at` back would pass just as well
   * against a stamp nothing consults.
   */
  @Test fun aMeetingThatYieldsNoItemsIsSweptOnceAndNeverAgain() {
    ensureCore()
    val m = aMeeting(WITHOUT_ITEMS)
    assertTrue(
      "precondition: an unmigrated meeting with a transcript is in the backlog",
      db.unmigratedMeetings(ALL).contains(m),
    )

    val written = db.backfillItems(m)

    assertEquals("precondition: this transcript is supposed to yield no items at all", 0, written)
    assertTrue("precondition: and to leave none behind", db.items(m).isEmpty())
    assertFalse(
      "a meeting whose transcript legitimately produces no items is still in the backlog after " +
        "being migrated: it comes back in every batch forever, the count never reaches zero, and " +
        "every library focus burns its whole pass budget re-extracting finished meetings",
      db.unmigratedMeetings(ALL).contains(m),
    )
  }

  /**
   * A meeting the pipeline already wrote items for is never swept.
   *
   * The seeded state is exactly what `ProcessingEngine` leaves behind for a meeting recorded on
   * this build — items, and no marker, because nothing on that path stamps one. Sweeping it would
   * not be a wasted pass, it would be a reprocess: `backfillItems` calls `replaceItems`, which runs
   * the reconciler, which deletes an untouched row the rules no longer produce. And the window is
   * real rather than theoretical — a meeting between ASR finishing and the pipeline writing its
   * items has a transcript and no items, which is the one state this clause cannot distinguish, so
   * [StorageModule.backfillItems] re-asks the guard per meeting as well.
   */
  @Test fun aMeetingThePipelineAlreadyWroteItemsForIsNeverSwept() {
    ensureCore()
    val m = aMeeting(WITH_ITEMS)
    db.replaceItems(m, Minutes.RULES_GEN, Minutes.extractItems(db.utterances(m), db.speakers(m)))
    assertTrue("precondition: the pipeline's items are on disk", db.items(m).isNotEmpty())

    assertFalse(
      "a meeting that already has items is in the migration backlog, so the sweep will re-run the " +
        "rules over it — which is a reprocess, and the reconciler deletes untouched rows on one",
      db.unmigratedMeetings(ALL).contains(m),
    )
  }

  // ---- The sweep itself --------------------------------------------------------------------

  /**
   * A backlog drains to zero, and what was ticked stays ticked.
   *
   * Three meetings, and the mix is the point: two the rules fire on and one they do not, because a
   * backlog containing a single zero-item meeting is a backlog that never reaches zero without the
   * marker. The tick is here rather than left to BackfillTest because the sweep is the path that
   * will actually carry most of them — a person who updates and never opens an old meeting gets
   * every tick they ever made through this loop or not at all.
   */
  @Test fun theSweepDrainsTheBacklogAndCarriesTheTicksItFinds() {
    ensureCore()
    val ticked = aMeeting(WITH_ITEMS)
    val tickedText = tickAnActionTheOldWay(ticked)
    val quiet = aMeeting(WITHOUT_ITEMS)
    val third = aMeeting(WITH_ITEMS)

    // Captured BEFORE the loop, so "it drained" is a statement about work that existed. An
    // assertion on the loop counter cannot say that — `remaining` starts at Int.MAX_VALUE, so the
    // body always runs once and `passes > 0` is true however little the predicate selected.
    assertTrue(
      "precondition: all three seeded meetings are in the backlog the loop is about to drain",
      db.unmigratedMeetings(ALL).containsAll(listOf(ticked, quiet, third)),
    )

    var remaining = Int.MAX_VALUE
    var passes = 0
    while (remaining > 0 && passes < 200) {
      remaining = sweep(12)
      passes++
    }

    assertEquals(
      "the backlog never reached zero in $passes passes of twelve. If this fires on a device with " +
        "real meetings on it, suspect a per-meeting failure before the marker or the loop: " +
        "StorageModule.backfillItems swallows a throw from one meeting on purpose, so a single " +
        "transcript the rule pass cannot handle surfaces HERE, as a backlog that will not drain, " +
        "and not as an error naming the meeting",
      0, remaining,
    )
    assertTrue("the ticked meeting gained no items", db.items(ticked).isNotEmpty())
    assertTrue("the third meeting gained no items", db.items(third).isNotEmpty())
    assertTrue("the quiet meeting was given items it cannot have", db.items(quiet).isEmpty())

    val action = db.items(ticked).first { it.kind == "action" }
    assertEquals(
      "the item text no longer matches the minute the tick was keyed on, so no tick could move",
      tickedText, action.text,
    )
    assertTrue(
      "somebody's finished action came back unticked after the library-wide migration",
      db.doneItemIds(ticked).contains(action.id),
    )
    assertTrue(
      "meetings the sweep reported as drained are still in the backlog",
      db.unmigratedMeetings(ALL).isEmpty(),
    )
  }

  /**
   * The number a pass resolves is the backlog STILL to go — a count, not a yes/no.
   *
   * The JavaScript loop stops when this reaches zero and, before that, when a pass fails to SHRINK
   * it. Both of those need a real count. `backfillSearch` resolves `unindexedMeetings(1).size`,
   * which is 0 or 1 by construction, so its loop reads 1, then 1 again, decides the backlog is not
   * shrinking and breaks out after two passes — twenty-four meetings a focus, latching never. That
   * is the shape a reader copying the neighbouring method would reproduce here.
   *
   * FOUR seeded meetings and a pass of two, and the numbers are the test. An earlier version
   * seeded three, so the backlog left over was ONE — the single value a yes/no answer returns
   * correctly by accident — and the mutation ran green: `unmigratedMeetings(1).size` passed both
   * assertions. Four leaves at least two outstanding, which no 0-or-1 answer can report.
   */
  @Test fun aPassReportsWhatIsLeftRatherThanWhatItDid() {
    ensureCore()
    aMeeting(WITH_ITEMS)
    aMeeting(WITH_ITEMS)
    aMeeting(WITHOUT_ITEMS)
    aMeeting(WITHOUT_ITEMS)
    val before = db.unmigratedMeetings(ALL).size
    assertTrue("precondition: at least the four seeded meetings are outstanding", before >= 4)

    val remaining = sweep(2)

    assertEquals(
      "a pass reported something other than the meetings still outstanding — a loop that stops " +
        "on this number leaves a library half migrated and latched",
      db.unmigratedMeetings(ALL).size, remaining,
    )
    assertEquals("a pass of two did not migrate two meetings", before - 2, remaining)
    assertTrue(
      "the backlog left over is 1, which is the one number a 0-or-1 answer gets right by accident",
      remaining >= 2,
    )
  }

  // ---- ensureItems, under the new guard ----------------------------------------------------

  /** The per-meeting trigger still migrates, and what it migrates leaves the backlog. */
  @Test fun ensureItemsMigratesAMeetingAndTakesItOutOfTheBacklog() {
    ensureCore()
    val m = aMeeting(WITH_ITEMS)
    assertTrue("precondition: the meeting starts with no items", db.items(m).isEmpty())

    db.ensureItems(m)

    assertTrue("a pre-items meeting was opened and stayed empty", db.items(m).isNotEmpty())
    assertFalse("a migrated meeting is still in the backlog", db.unmigratedMeetings(ALL).contains(m))
  }

  /**
   * The lazy trigger stops re-running for a meeting that legitimately produced nothing.
   *
   * Telling "it has not run" from "it ran and found nothing" is the entire difficulty, and no read
   * of `items` can do it — so the transcript is REPLACED with one the rules do fire on, and the
   * assertion is that they are not run again anyway. Nothing in production swaps a transcript
   * without also writing items (a re-ASR goes through the pipeline, which calls `replaceItems`
   * itself), so this is a lever rather than a scenario: it is the only way to make "did not run"
   * observable, and against the old guard it produces items and fails.
   */
  @Test fun ensureItemsDoesNotRunASecondTimeForAMeetingThatProducedNothing() {
    ensureCore()
    val m = aMeeting(WITHOUT_ITEMS)
    db.ensureItems(m)
    assertTrue("precondition: the transcript yields nothing", db.items(m).isEmpty())

    db.replaceUtterancesJson(m, WITH_ITEMS)

    db.ensureItems(m)

    assertTrue(
      "the migration ran a second time for a meeting it had already been run for: with no marker " +
        "the guard is permanently true for a zero-item meeting, which is a wasted rule pass on " +
        "every open and an undrainable backlog under the sweep",
      db.items(m).isEmpty(),
    )
  }
}
