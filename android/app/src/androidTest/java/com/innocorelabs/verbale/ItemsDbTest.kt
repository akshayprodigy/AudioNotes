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
 *  - `item_done` — the tick, keyed on the item's id. Task 8's migration is what fills it.
 *  - `action_done` — the tick as every SHIPPED build has ever written it, keyed on a hash of the
 *    item's TEXT. Until Task 8 has run for a meeting this is the only place a real tick exists, so
 *    a `touched` that consults `item_done` alone reads every existing library as untouched.
 *  - `edits` — a hand correction. Task 11 starts writing these; the join returns nothing today.
 *
 * And the mirror image, which matters as much: `needs_review` is the RECONCILER's own flag, not a
 * person's, and an item nobody has touched must still be droppable however many times it has been
 * flagged. Otherwise five reprocesses turn a review queue into permanent clutter.
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
      survivesWith { m, id ->
        exec("INSERT INTO item_done(meeting_id,item_id,done_at) VALUES(?,?,?)", m, id, "1")
      },
    )
  }

  /**
   * The tick as it exists on every phone in the field today.
   *
   * `item_done` has no writer in the repo: every tick the shipped app has recorded went to
   * `action_done`, keyed on a hash of the item's text. A `touched` that joins `item_done` alone is
   * correct in a test and wrong on every existing library, which is the population this sub-project
   * exists for. SQL cannot compute that hash — it is JS arithmetic mirrored in [ItemKey] — so this
   * cannot be a join and the set membership has to happen in Kotlin.
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

  @Test fun replacingItemsKeepsTheirIdsStableWhenNothingChanged() {
    inAMeeting { m ->
      val rows = listOf(anAction())
      db.replaceItems(m, "rules@1", rows)
      val first = db.items(m).map { it.id }
      val createdAt = db.items(m).single().createdAt
      db.replaceItems(m, "rules@1", rows)
      assertEquals(first, db.items(m).map { it.id })
      // The created_at of a row that continues an old one is the OLD one's: an item confirmed in
      // March must not read as written today after a reprocess.
      assertEquals(createdAt, db.items(m).single().createdAt)
    }
  }

  /** Every item hit for one meeting, from the real search path JS calls. */
  private fun itemHits(meetingId: String, term: String): List<JSONObject> {
    val all = JSONArray(db.searchJson(term))
    val out = ArrayList<JSONObject>()
    for (i in 0 until all.length()) {
      val row = all.getJSONObject(i)
      if (row.getString("meetingId") == meetingId && row.getString("kind") == "item") out.add(row)
    }
    return out
  }
}
