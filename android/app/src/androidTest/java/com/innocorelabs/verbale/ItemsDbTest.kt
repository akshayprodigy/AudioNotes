package com.innocorelabs.verbale

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ItemKey
import com.innocorelabs.verbale.pipeline.Minutes
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Persisting items, and the four ways a person can have touched one.
 *
 * `Reconciler` decides what survives a reprocess and `ReconcilerTest` pins that on the JVM. This
 * file pins the half the JVM cannot see: whether [AudioDb.items] actually FINDS the engagement it
 * hands the reconciler. Nothing about that is structural — a `touched` that forgets a table still
 * compiles, still returns items, and still looks right on screen; the only symptom is a tick or a
 * person's own words disappearing from a meeting weeks later, with no error anywhere. So there is
 * one test per signal, each carrying that signal and NOTHING else, and each one is a real database
 * because the predicate is SQL plus a hash and neither exists off-device.
 *
 * The signals, and why all four:
 *
 *  - `items.review` = 'confirmed' — a person said yes.
 *  - `item_done` — the tick, keyed on the item's id. `AudioDb.backfillItems` is what fills it in
 *    bulk, and it does so ONE MEETING AT A TIME, on demand — which is why the next signal is still
 *    consulted rather than retired.
 *  - `action_done` — the tick as every SHIPPED build has ever written it, keyed on a hash of the
 *    item's TEXT. Until Task 8 has run for a meeting this is the only place a real tick exists, so
 *    a `touched` that consults `item_done` alone reads every existing library as untouched.
 *  - `edits` — a hand correction. Task 11 starts writing these; the join returns nothing today.
 *
 * And the mirror image, which matters as much: `needs_review` is the RECONCILER's own flag, not a
 * person's, and an item nobody has touched must still be droppable however many times it has been
 * flagged. Otherwise five reprocesses turn a review queue into permanent clutter.
 *
 * The other half of the file is the two facts `Reconciler` computes and only `replaceItems` can
 * keep: an item's original `created_at`, and `gen_version='user'` on a row a person typed. Both are
 * carried by a `?:` that compiles perfectly well without being there, and both losses are invisible
 * on the screen the day they happen — a date that reads as today, and a hand-written item that
 * survives one reprocess and is deleted by the next.
 */
@RunWith(AndroidJUnit4::class)
class ItemsDbTest {
  private val db = AudioDb.get(InstrumentationRegistry.getInstrumentation().targetContext)

  private fun freshMeeting(): String {
    val id = "test-items-" + System.nanoTime()
    db.insertMeeting(id, "Items test", System.currentTimeMillis(), "free", "/dev/null")
    return id
  }

  private val ACTION_TEXT = "Send the report — Unassigned"

  private fun anAction() = Minutes.Item(
    "action", ACTION_TEXT, listOf(Minutes.Source("u1", 5000L, 9000L, 0, 16)), 5000L, 9000L,
  )

  /**
   * A second reprocess that no longer extracts the first item: an hour later, not one word shared,
   * so no anchor overlaps and nothing can match. Whatever comes back with the old id came back
   * because rule 4 kept it.
   */
  private fun reprocessWithoutIt(meetingId: String) = db.replaceItems(
    meetingId, "rules@2",
    listOf(
      Minutes.Item(
        "action", "Book the venue — Priya",
        listOf(Minutes.Source("u9", 3_600_000L, 3_604_000L, 0, 21)),
        3_600_000L, 3_604_000L,
      ),
    ),
  )

  /** Runs [body] against a meeting of its own and takes the meeting away afterwards. */
  private fun inAMeeting(body: (String) -> Unit) {
    val m = freshMeeting()
    try {
      body(m)
    } finally {
      db.deleteMeeting(m)
    }
  }

  /** Write the one item, apply one signal to it, reprocess it away, and say whether it survived. */
  private fun survivesWith(signal: (meetingId: String, itemId: String) -> Unit): Boolean {
    var survived = false
    inAMeeting { m ->
      db.replaceItems(m, "rules@1", listOf(anAction()))
      val id = db.items(m).single().id
      signal(m, id)
      // The point of the whole exercise: the boundary, not the caller, sees the engagement.
      assertTrue("items() did not see the signal at all", db.items(m).single().touched)
      reprocessWithoutIt(m)
      val kept = db.items(m).firstOrNull { it.id == id }
      survived = kept != null
      if (kept != null) {
        assertEquals("a retained row is flagged, not silently kept", "needs_review", kept.review)
        assertEquals("a retained row keeps its own text", ACTION_TEXT, kept.text)
      }
    }
    return survived
  }

  /**
   * Bound DML, through the path JS already uses.
   *
   * `AudioDb.exec` is the narrower name and would read better, but it takes no bind arguments, and
   * an item id interpolated into SQL is a test that breaks on the first id with a quote in it.
   * `rawQueryJson` routes anything that is not a SELECT to `execSQL` with its arguments bound —
   * chosen for that, not stumbled into.
   */
  private fun exec(sql: String, vararg args: String) = db.rawQueryJson(sql, arrayOf<String?>(*args))

  // ---- The four signals ------------------------------------------------------------------

  @Test fun aConfirmedItemSurvivesAReprocessThatNoLongerExtractsIt() {
    assertTrue(
      "a person said yes to this item and the reprocess deleted it",
      survivesWith { _, id -> exec("UPDATE items SET review='confirmed' WHERE id=?", id) },
    )
  }

  @Test fun anItemTickedInItemDoneSurvivesAReprocessThatNoLongerExtractsIt() {
    assertTrue(
      "the tick was in item_done and the reprocess deleted the item under it",
      // Through the real writer, not a hand-rolled copy of the statement it runs: setItemDone is
      // the tick gesture's writer and has no other test.
      survivesWith { m, id -> db.setItemDone(m, id, true) },
    )
  }

  /**
   * The tick as it exists on every phone in the field today.
   *
   * Every tick the shipped app has ever recorded went to `action_done`, keyed on a hash of the
   * item's text. `item_done` does have a writer now — `AudioDb.backfillItems` — but it fills one
   * meeting at a time, on demand, so until the migration has reached a given meeting every tick
   * that meeting has is still in the old table. A `touched` that joins `item_done` alone is
   * correct in a test and wrong on every library that has not been opened yet, which is the
   * population this sub-project exists for. SQL cannot compute that hash — it is JS arithmetic
   * mirrored in [ItemKey] — so this cannot be a join and the set membership has to happen in
   * Kotlin.
   */
  @Test fun anItemTickedInActionDoneSurvivesAReprocessThatNoLongerExtractsIt() {
    assertTrue(
      "the tick predates Task 8's migration and the reprocess deleted the item",
      survivesWith { m, _ ->
        exec(
          "INSERT INTO action_done(meeting_id,item_key,done_at) VALUES(?,?,?)",
          m, ItemKey.of(ACTION_TEXT), "1",
        )
      },
    )
  }

  @Test fun aHandEditedItemSurvivesAReprocessThatNoLongerExtractsIt() {
    assertTrue(
      "a person rewrote this item by hand and the reprocess deleted their words",
      survivesWith { m, id -> db.putEdit(m, "item", id, "Send the report — Priya") },
    )
  }

  // ---- And the mirror image --------------------------------------------------------------

  /**
   * `needs_review` is the machine's own flag. An item nobody ever touched must still be droppable.
   */
  @Test fun aNeedsReviewItemNobodyTouchedIsDropped() {
    inAMeeting { m ->
      db.replaceItems(m, "rules@1", listOf(anAction()))
      val id = db.items(m).single().id
      exec("UPDATE items SET review='needs_review' WHERE id=?", id)
      assertFalse("the reconciler's own flag is not engagement", db.items(m).single().touched)
      reprocessWithoutIt(m)
      assertNull(
        "a flag the machine set itself made the row permanently undroppable",
        db.items(m).firstOrNull { it.id == id },
      )
    }
  }

  // ---- Writing, reading and indexing -----------------------------------------------------

  @Test fun writesItemsAndTheirSources() {
    inAMeeting { m ->
      db.replaceItems(m, "rules@1", listOf(anAction()))
      val items = db.items(m)
      assertEquals(1, items.size)
      assertEquals(5000L, items[0].anchorStartMs)
      assertEquals("rules@1", items[0].genVersion)
      assertEquals("suggested", items[0].review)
      assertFalse(items[0].touched)
      assertEquals(1, items[0].sources.size)
      assertEquals(9000L, items[0].sources[0].endMs)
      assertEquals(0, items[0].sources[0].charStart)
      assertEquals(16, items[0].sources[0].charEnd)
      assertEquals("u1", items[0].sources[0].utteranceId)
    }
  }

  /** A search hit on an item must open the meeting at the moment it was said, not at zero. */
  @Test fun indexesItemsAtTheirAnchor() {
    inAMeeting { m ->
      db.replaceItems(
        m, "rules@1",
        listOf(
          Minutes.Item(
            "decision", "We agreed to ship on Monday",
            listOf(Minutes.Source("u1", 61000L, 64000L, 0, 27)), 61000L, 64000L,
          ),
        ),
      )
      val hits = itemHits(m, "agreed to ship on Monday")
      assertEquals(1, hits.size)
      assertEquals(61000L, hits[0].getLong("startMs"))
    }
  }

  /**
   * A reindex must not lose them.
   *
   * `reindexMeeting` deletes every index row for the meeting and rebuilds it, and it runs on a
   * backlog sweep, after a speaker merge and after every hand edit — so an item indexed only by
   * `replaceItems` would vanish from search the first time anybody corrected a word, silently.
   */
  @Test fun aReindexKeepsItemHits() {
    inAMeeting { m ->
      db.replaceItems(
        m, "rules@1",
        listOf(
          Minutes.Item(
            "decision", "We agreed to ship on Monday",
            listOf(Minutes.Source("u1", 61000L, 64000L, 0, 27)), 61000L, 64000L,
          ),
        ),
      )
      db.reindexMeeting(m)
      val hits = itemHits(m, "agreed to ship on Monday")
      assertEquals(1, hits.size)
      assertEquals(61000L, hits[0].getLong("startMs"))
    }
  }

  /**
   * A reprocess that changed nothing keeps every id, and every row's original date.
   *
   * The date is forced to an impossible one rather than captured and compared, and that is the
   * whole test. `replaceItems` writes `r.createdAt ?: now`; an implementation that ignored the
   * plan's value and stamped `now` unconditionally would pass a capture-and-compare whenever the
   * two writes land in the same millisecond, which on a real phone is most runs — a test that is
   * usually incapable of failing. A row dated 1000 cannot be re-stamped by accident.
   *
   * Lost, if it breaks: the date an item was first raised. An item somebody confirmed in March
   * reads as written today after any reprocess, and the original is recoverable from nowhere.
   */
  @Test fun replacingItemsKeepsTheirIdsAndTheirOriginalDate() {
    inAMeeting { m ->
      val rows = listOf(anAction())
      db.replaceItems(m, "rules@1", rows)
      val first = db.items(m).map { it.id }
      exec("UPDATE items SET created_at=1000 WHERE meeting_id=?", m)

      db.replaceItems(m, "rules@1", rows)

      assertEquals(first, db.items(m).map { it.id })
      assertEquals(
        "the row was re-stamped with now instead of keeping its own created_at",
        1000L, db.items(m).single().createdAt,
      )
    }
  }

  /**
   * A person's own item is still theirs after two reprocesses.
   *
   * TWO, because one hides the consequence. `replaceItems` writes `r.genVersion ?: genVersion`,
   * and an implementation that wrote the run's version unconditionally relabels a hand-written row
   * `rules@N` on the first pass — where it still exists, still reads correctly, and looks fine. On
   * the SECOND pass it is no longer a user row, so rule 1 no longer sets it aside, nothing extracts
   * it, nobody has touched it, and rule 4 deletes it. A one-reprocess test watches the damage being
   * done and calls it a pass.
   *
   * Lost: an item a person typed themselves, which no recogniser will ever produce again.
   */
  @Test fun aPersonsOwnItemIsStillTheirsAfterTwoReprocesses() {
    inAMeeting { m ->
      db.replaceItems(m, "rules@1", listOf(anAction()))
      val id = db.items(m).single().id
      // Task 12 is what gives a person a way to write one; the column is the only thing that says
      // an item is theirs, so setting it directly is the same row that screen will produce.
      exec("UPDATE items SET gen_version='user' WHERE id=?", id)

      reprocessWithoutIt(m)
      val afterOne = db.items(m).first { it.id == id }
      assertEquals("relabelled as rules output by the first reprocess", "user", afterOne.genVersion)
      // Rule 1 sets user rows aside before anything else, so an untouched one is not flagged either.
      assertEquals("suggested", afterOne.review)

      reprocessWithoutIt(m)
      val afterTwo = db.items(m).firstOrNull { it.id == id }
      assertNotNull("the person's own item was deleted by the second reprocess", afterTwo)
      assertEquals("user", afterTwo!!.genVersion)
      assertEquals(ACTION_TEXT, afterTwo.text)
    }
  }

  /**
   * A tick in another meeting is not a tick here.
   *
   * `action_done`'s key is a hash of the item's TEXT, and "Send the report — Unassigned" is the
   * same text in every meeting that says it. The set is read per meeting for that reason; read
   * library-wide it would mark an item touched — and so undroppable, forever — because somebody
   * ticked a similar-sounding action in a different meeting last month.
   */
  @Test fun aTickInAnotherMeetingDoesNotCountAsThisOnesTick() {
    inAMeeting { other ->
      exec(
        "INSERT INTO action_done(meeting_id,item_key,done_at) VALUES(?,?,?)",
        other, ItemKey.of(ACTION_TEXT), "1",
      )
      inAMeeting { m ->
        db.replaceItems(m, "rules@1", listOf(anAction()))
        val id = db.items(m).single().id
        assertFalse("another meeting's tick was read as this item's", db.items(m).single().touched)
        reprocessWithoutIt(m)
        assertNull(
          "another meeting's tick kept this untouched item alive",
          db.items(m).firstOrNull { it.id == id },
        )
      }
    }
  }

  /**
   * Two items, two sources each: every source on the item that actually said it.
   *
   * The only other test that touches `.sources` has one item with one source, and a meeting like
   * that cannot tell a correct grouping from one that hands every item the same list — nor can any
   * of the tests that end up with two items, because they assert id, text and review and never the
   * evidence. So the whole of `items()`'s source handling was unpinned in both directions.
   *
   * Why that is worse here than a getter returning the wrong list: `Reconciler` rule 4 reads
   * `old.sources` off a retained row and writes it STRAIGHT BACK to disk. A mis-keyed grouping does
   * not merely draw the wrong evidence on a screen, it persists another item's moments onto the
   * item a person kept — the one item in the meeting whose provenance somebody is relying on — and
   * says nothing. That is this sub-project's own failure shape, in the place nothing was looking.
   *
   * Item ORDER is asserted for the same reason: [AudioDb.items] promises the order the meeting said
   * them, and `Reconciler` breaks scoring ties on stored position, so the promise is load-bearing
   * rather than cosmetic. The two items are written in the wrong order deliberately — the action is
   * five minutes later and goes in first — so the assertion is about the query rather than about
   * the order they happened to be inserted in.
   *
   * What the two ordering assertions can and cannot catch, because the difference was measured
   * rather than assumed: on a phone, DELETING either `ORDER BY` changes nothing at all. An index
   * already returns the rows that way — the (item_id, ordinal) primary key for the evidence,
   * idx_items_meeting for the items — so a deleted clause is invisible here, and would be to any
   * test. REVERSING either fails immediately. So what is pinned is the order that ARRIVES, which is
   * the contract every caller reads, and the day a query shape or an index stops agreeing with the
   * clause is the day this catches it.
   */
  @Test fun eachItemComesBackWithItsOwnSourcesInOrder() {
    inAMeeting { m ->
      val decision = Minutes.Item(
        "decision", "We agreed to ship on Monday",
        listOf(
          Minutes.Source("u1", 61_000L, 64_000L, 0, 27),
          Minutes.Source("u4", 120_000L, 123_000L, 5, 32),
        ),
        61_000L, 123_000L,
      )
      val action = Minutes.Item(
        "action", "Send the report — Priya",
        listOf(
          Minutes.Source("u9", 300_000L, 304_000L, 0, 23),
          Minutes.Source("u11", 420_000L, 424_000L, 8, 31),
        ),
        300_000L, 424_000L,
      )
      db.replaceItems(m, "rules@1", listOf(action, decision))

      val items = db.items(m)
      assertEquals(2, items.size)
      assertEquals(
        "the later item came back first: anchor order is not insertion order",
        "We agreed to ship on Monday", items[0].text,
      )
      assertEquals("Send the report — Priya", items[1].text)

      assertEquals(
        "the decision was handed the wrong item's evidence",
        listOf("u1", "u4"), items[0].sources.map { it.utteranceId },
      )
      assertEquals(listOf(61_000L, 120_000L), items[0].sources.map { it.startMs })
      assertEquals(listOf(0, 5), items[0].sources.map { it.charStart })
      assertEquals(
        "the action was handed the wrong item's evidence",
        listOf("u9", "u11"), items[1].sources.map { it.utteranceId },
      )
      assertEquals(listOf(300_000L, 420_000L), items[1].sources.map { it.startMs })
      assertEquals(listOf(304_000L, 424_000L), items[1].sources.map { it.endMs })
    }
  }

  /** Every item hit for one meeting, from the real search path JS calls. */
  private fun itemHits(meetingId: String, term: String): List<JSONObject> {
    val all = JSONArray(db.searchJson(InstrumentationRegistry.getInstrumentation().targetContext, term))
    val out = ArrayList<JSONObject>()
    for (i in 0 until all.length()) {
      val row = all.getJSONObject(i)
      if (row.getString("meetingId") == meetingId && row.getString("kind") == "item") out.add(row)
    }
    return out
  }
}
