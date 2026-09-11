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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Every decision, action and open question a person has ever TYPED, moved out of `minutes`.
 *
 * THE FAILURE THIS EXISTS TO CATCH IS THE MOST USER-VISIBLE ONE THIS SUB-PROJECT CAN PRODUCE.
 * Task 12 stops the tabs and the export renderer merging `minutes` rows with `source='user'` back
 * into the list — they are `items` rows now, written by `db.addUserItem`. Everything a person has
 * already typed into any meeting is still in `minutes`, so without this migration every one of
 * them disappears from the meeting it was typed into the moment the update lands. Nothing throws,
 * nothing is deleted, and the row is still on disk: it simply stops being drawn and stops being
 * exported.
 *
 * WHY IT CANNOT BE A JVM TEST. It is SQLite from end to end — a move between two tables, a tick
 * carried out of `action_done` into `item_done`, a correction re-keyed in `edits`, and a delete —
 * and it is checked against the state a SHIPPED build really leaves behind, which means real
 * `Minutes.extract` output rather than a literal. A JVM test can open no database at all.
 *
 * WHAT THE MOVE HAS TO CARRY, and each is a separate loss if it is dropped:
 *
 *  - the row itself, with its text unchanged (it is the only copy of a sentence nobody said);
 *  - `gen_version = 'user'`, which is what makes `Reconciler` rule 1 protect it from the very next
 *    reprocess — a row relabelled `rules@1` is deleted by rule 4 as soon as the rules do not
 *    produce it, which they never will;
 *  - its TICK, which lives in `action_done` keyed on a hash of the text. After the move the tab
 *    reads `item_done` for a row that has an item, so a tick left behind reads as unticked work
 *    somebody has already done;
 *  - its CORRECTION, which lives in `edits` keyed `minute/<hash>`. After the move the reader asks
 *    for `item/<id>`, and `edits` has a foreign key to `meetings` and none to `items`, so a
 *    correction left behind joins to nothing — silently.
 *
 * AND WHAT IT MUST NOT DO: touch prose. A hand-written `summary`, `narrative` or `headline` stays
 * in `minutes`, because `items` has nothing to offer a document — no anchor, no tick, no
 * provenance, one per meeting.
 *
 * DEVICE-ONLY AND, AS COMMITTED, UNEXECUTED. The Galaxy A07 is off the USB bus; this class is
 * registered in scripts/device-verify.sh and has never been run. It compiles
 * (`:app:assembleDebugAndroidTest`) and nothing in this commit is claimed on device evidence.
 */
@RunWith(AndroidJUnit4::class)
class UserItemsMigrationTest {
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
    val m = "test-user-items-" + System.nanoTime()
    db.insertMeeting(m, "User items test", System.currentTimeMillis(), "free", "/dev/null")
    try {
      db.replaceUtterancesJson(m, TRANSCRIPT)
      body(m)
    } finally {
      db.deleteMeeting(m)
    }
  }

  private fun json(sql: String, vararg args: String) =
    JSONArray(db.rawQueryJson(sql, arrayOf<String?>(*args)))

  private fun minuteRows(meetingId: String) = json(
    "SELECT id,kind,content_json AS content,source FROM minutes WHERE meeting_id=? ORDER BY rowid",
    meetingId,
  )

  /**
   * What a SHIPPED build's `db.addUserMinute` wrote: a plain-text `minutes` row, source='user'.
   *
   * Written with raw SQL rather than through any Kotlin helper because there is no Kotlin writer
   * for it and never was — the row is JavaScript's. Plain text, not JSON: the column is called
   * `content_json` and holds a bare string everywhere, which `addUserMinute` learned the hard way.
   *
   * THE COUNTER IS THE FIX FOR THE FIRST THING THIS FILE'S FIRST DEVICE RUN FOUND. The id was
   * `"$meetingId:user:$kind"`, which is unique per KIND and not per row, so the moment a fixture
   * typed two actions into one meeting — which is exactly what a test about ticking the right one
   * of two rows has to do — the second INSERT hit `UNIQUE constraint failed: minutes.id`. It is
   * the same generator flaw found in `db.addUserItem` on the host last round (a bare `Date.now()`
   * id, two rows in one millisecond), arrived at independently in the other language, and nothing
   * off a device could reach it. A monotonic counter rather than a clock, because a clock is what
   * produced the other one.
   */
  private var typed = 0

  private fun typeAMinute(meetingId: String, kind: String, content: String): String {
    val id = "$meetingId:user:$kind:${typed++}"
    db.exec(
      "INSERT INTO minutes(id,meeting_id,kind,content_json,source) " +
        "VALUES('$id','$meetingId','$kind','${content.replace("'", "''")}','user')",
    )
    return id
  }

  private fun userItems(meetingId: String) =
    db.items(meetingId).filter { it.genVersion == AudioDb.Gen.USER }

  // ---- The move ------------------------------------------------------------------------------

  /**
   * A typed decision becomes an item, and the row it came from is gone.
   *
   * The single assertion this file exists for. It also pins the DELETE, which is not tidiness: a
   * left-behind `minutes` row is not dormant, it is RENDERED — the empty-items fallback in
   * `toItemRows` and `exportItems` shows every `minutes` row of an item kind, so the moment a
   * person deletes the typed item they just migrated, the meeting has no rule items left and the
   * row they deleted comes back from the dead. It would also be indexed twice, giving two search
   * cards for one sentence.
   *
   * Deleting is safe here in a way that deleting `action_done` would not be: the content is
   * reproduced verbatim in `items.text`, whereas a tick exists nowhere else. And the rollback
   * argument is already spent — `db.addUserItem` writes only to `items`, so a rolled-back build
   * has lost every row typed since the update whatever this does.
   */
  @Test fun aTypedDecisionBecomesAnItemAndTheMinuteRowIsGone() {
    inAMeeting { m ->
      typeAMinute(m, "decision", "Ship the beta to the pilot group")
      typeAMinute(m, "action", "Book the venue — Priya")

      assertEquals(2, db.carryUserMinutesOntoItems(m))

      val moved = userItems(m)
      assertEquals(
        listOf("Ship the beta to the pilot group", "Book the venue — Priya"),
        moved.map { it.text },
      )
      assertEquals(listOf("decision", "action"), moved.map { it.kind })
      assertEquals("nothing typed may be left in minutes", 0, minuteRows(m).length())
    }
  }

  /**
   * It arrives confirmed, citing nothing, and marked as the person's.
   *
   * `gen_version` is the one that matters and it is the one that fails silently: relabelled
   * `rules@1`, the row loses rule 1's protection and rule 4 deletes it on the first reprocess,
   * because the rules will never extract a sentence nobody said.
   */
  @Test fun aMovedRowIsConfirmedCitesNothingAndKeepsItsGenVersion() {
    inAMeeting { m ->
      typeAMinute(m, "decision", "Ship the beta to the pilot group")
      db.carryUserMinutesOntoItems(m)

      val moved = userItems(m).single()
      assertEquals(AudioDb.Review.CONFIRMED, moved.review)
      assertEquals(AudioDb.Gen.USER, moved.genVersion)
      assertTrue("a typed row was given evidence it never claimed", moved.sources.isEmpty())
      assertTrue("a typed row is engagement by definition", moved.touched)
    }
  }

  /**
   * It stores the sentinel anchor, and it sorts LAST.
   *
   * `anchor_start_ms` is `INTEGER NOT NULL`, so the row has to hold a number; `0` would put every
   * typed row at the top of every meeting, which is not where any of them has ever been, and would
   * print `[0:00]` on an exported document. Two rule items here, one of them anchored at the very
   * start of the recording, so "last" is a claim with something to fail against.
   */
  @Test fun aMovedRowStoresTheSentinelAnchorAndSortsLast() {
    inAMeeting { m ->
      typeAMinute(m, "action", "Book the venue — Priya")
      db.carryUserMinutesOntoItems(m)
      db.replaceItems(m, Minutes.RULES_GEN, Minutes.extractItems(db.utterances(m), db.speakers(m)))

      val all = db.items(m)
      assertTrue("the fixture needs rule items for `last` to mean anything", all.size >= 3)
      assertEquals(AudioDb.Gen.USER, all.last().genVersion)
      assertEquals(AudioDb.Gen.NO_ANCHOR, all.last().anchorStartMs)
      assertEquals(AudioDb.Gen.NO_ANCHOR, all.last().anchorEndMs)
      assertFalse(
        "a rule item was given the sentinel too",
        all.first().anchorStartMs == AudioDb.Gen.NO_ANCHOR,
      )
    }
  }

  /**
   * A search hit on a typed item opens the meeting at the TOP — and an extracted one still opens
   * at the moment it was said.
   *
   * `indexItems` writes the anchor into `search_fts.start_ms`, which is where a hit is opened from.
   * 0 is what every row with no moment already writes there — `indexTitle`, `indexMinutes` and
   * `indexSummary` all do — and it is exactly what this row got while it was a `minutes` row, so
   * the behaviour a person sees is unchanged. The sentinel would be a number that is neither a
   * moment nor a marker for one.
   *
   * THE RULE ITEMS ARE THE POINT OF THE FIXTURE, not scenery. Seeded with the typed row alone this
   * test killed the mutant that deletes the `CASE` and could not fail against `indexItems` writing
   * a CONSTANT 0 for every item — which would break search-to-moment for every extracted item in
   * the app, and which no other test in the tree asserts. That is the single-row fixture this
   * branch has now found a dozen times, landing in the task whose own brief warned about it: the
   * warning was applied to fixtures about ORDER and SELECTION and this one reads as a fixture about
   * a single value, which it is not — it is a fixture about a CASE with two branches, and a branch
   * needs a row on each side.
   */
  @Test fun aTypedItemIsSearchableAndOpensAtTheTop() {
    inAMeeting { m ->
      typeAMinute(m, "decision", "Ship the beta to the pilot group")
      db.carryUserMinutesOntoItems(m)
      // The rules over this transcript produce a decision at 61s and an action at 125s; both are
      // indexed from their own anchors, and neither may be dragged to 0 by the typed row's branch.
      db.replaceItems(m, Minutes.RULES_GEN, Minutes.extractItems(db.utterances(m), db.speakers(m)))
      db.reindexMeeting(m)

      val typedHits = json(
        "SELECT kind,start_ms AS startMs FROM search_fts WHERE meeting_id=? AND text MATCH 'pilot'",
        m,
      )
      assertEquals(1, typedHits.length())
      assertEquals("item", typedHits.getJSONObject(0).getString("kind"))
      assertEquals(0L, typedHits.getJSONObject(0).getLong("startMs"))

      // Every item the rules produced, read back from the index by its own id, so the assertion is
      // about each row's anchor rather than about whichever row the FTS ranker happened to put
      // first. Two of them, at different non-zero moments: a constant 0 fails on both, and a CASE
      // inverted to zero the WRONG branch fails on both too.
      val ruleItems = db.items(m).filter { it.genVersion == Minutes.RULES_GEN }
      assertTrue("the fixture needs at least two rule items", ruleItems.size >= 2)
      for (it in ruleItems) {
        val indexed = json(
          "SELECT start_ms AS startMs FROM search_fts WHERE meeting_id=? AND kind='item' " +
            "AND ref_id=?",
          m, it.id,
        )
        assertEquals("an extracted item was not indexed", 1, indexed.length())
        assertEquals(
          "an extracted item's search hit was dragged to the top of the recording",
          it.anchorStartMs, indexed.getJSONObject(0).getLong("startMs"),
        )
      }
      assertTrue(
        "every rule item is anchored at 0, so this fixture cannot see a constant",
        ruleItems.any { it.anchorStartMs > 0 },
      )
    }
  }

  // ---- What travels with it -------------------------------------------------------------------

  /**
   * The tick moves with the row, keeping the day it was ticked.
   *
   * After the move the Actions tab reads `item_done` for any row that has an item, so a tick left
   * in `action_done` draws as unticked work somebody has already done — the exact failure
   * `item_done` was created to end, reintroduced by a migration that only moved half of it.
   *
   * `done_at` comes across rather than being stamped now, for `backfillItems`' reason: telling
   * somebody they finished this morning something they crossed off in March is unrecoverable.
   *
   * A SECOND, UNTICKED typed row is in the fixture so that "the tick moved" cannot pass by ticking
   * everything.
   */
  @Test fun aTickOnATypedRowMovesOntoTheItemWithItsDate() {
    inAMeeting { m ->
      typeAMinute(m, "action", "Book the venue — Priya")
      typeAMinute(m, "action", "Ring the supplier — Sam")
      val ticked = 1_700_000_000_000L
      db.exec(
        "INSERT INTO action_done(meeting_id,item_key,done_at) VALUES('$m'," +
          "'${ItemKey.of("Book the venue — Priya")}',$ticked)",
      )

      db.carryUserMinutesOntoItems(m)

      val booked = userItems(m).first { it.text.startsWith("Book") }
      val rang = userItems(m).first { it.text.startsWith("Ring") }
      assertTrue("the tick did not move", db.doneItemIds(m).contains(booked.id))
      assertFalse("every row was ticked, not the one that was", db.doneItemIds(m).contains(rang.id))
      val rows = json("SELECT done_at AS at FROM item_done WHERE meeting_id=? AND item_id=?", m, booked.id)
      assertEquals(ticked, rows.getJSONObject(0).getLong("at"))
      // Never deleted: a rolled-back build has to find its ticks where it left them, and
      // StoredItem.touched still reads that table for meetings the migration has not reached.
      assertEquals(1, json("SELECT 1 FROM action_done WHERE meeting_id=?", m).length())
    }
  }

  /**
   * The correction moves onto the item's id, which is what every reader now asks for.
   *
   * It is `carryEditsOntoItems` that does it — no new matching logic — and the only thing this
   * task had to get right is the ORDER: the rows have to become items BEFORE the carry runs, or
   * there is no item for the correction to find and it is left where it is, invisible.
   *
   * WHY THIS ASSERTS ON `edits` AND NOT ON [AudioDb.StoredItem.touched], which is what it did
   * until its first device run. Both of those assertions were incapable of failing, and in
   * opposite directions. `carryUserMinutesOntoItems` writes `review = 'confirmed'`, and `touched`
   * is true for anything in `Review.BY_A_PERSON` — so EVERY hand-typed row reads touched whether
   * it has a correction or not. `assertTrue(shipped.touched)` would have passed with no correction
   * in the database at all, and `assertFalse(booked.touched)` could not pass under any
   * circumstances; the neighbouring [aMovedRowIsConfirmedCitesNothingAndKeepsItsGenVersion]
   * asserts the opposite of it, one screen away, and both were written in the same sitting.
   *
   * `touched` is the wrong instrument here because a typed row saturates it. The question this
   * test actually asks — did the correction land on the right row — is answered by the `edits`
   * table, where a wrong answer is visible. The signal-correlation question `touched` was reaching
   * for is a real one and gets its own test, on rows that do not saturate it:
   * [theEditSignalMarksOnlyTheItemItBelongsTo].
   */
  @Test fun aCorrectionOnATypedRowMovesOntoTheItemId() {
    inAMeeting { m ->
      typeAMinute(m, "decision", "Ship the beta to the pilot group")
      typeAMinute(m, "action", "Book the venue — Priya")
      db.putEdit(m, "minute", ItemKey.of("Ship the beta to the pilot group"), "Ship the beta to everyone")

      db.carryUserMinutesOntoItems(m)
      db.carryEditsOntoItems(m)

      val shipped = userItems(m).first { it.text.startsWith("Ship") }
      val booked = userItems(m).first { it.text.startsWith("Book") }
      val edits = json(
        "SELECT target_kind AS kind,target_key AS key,content FROM edits WHERE meeting_id=?", m,
      )
      assertEquals(1, edits.length())
      assertEquals("item", edits.getJSONObject(0).getString("kind"))
      assertEquals(shipped.id, edits.getJSONObject(0).getString("key"))
      assertEquals("Ship the beta to everyone", edits.getJSONObject(0).getString("content"))
      // The uncorrected row exists, is a separate item, and owns no correction. Without naming
      // `booked` at all the assertions above would hold in a meeting with one row in it.
      assertNotEquals(shipped.id, booked.id)
      assertEquals(
        "the uncorrected row was given a correction of its own",
        0,
        json("SELECT 1 FROM edits WHERE meeting_id=? AND target_key=?", m, booked.id).length(),
      )
    }
  }

  /**
   * THE EDIT SIGNAL MARKS ONE ITEM, and this is what nothing in the tree was pinning.
   *
   * `AudioDb.items()` reads `touched` partly from `LEFT JOIN edits e ON e.meeting_id=i.meeting_id
   * AND e.target_kind='item' AND e.target_key=i.id`. Drop that last correlation and every item in
   * a meeting holding ONE correction reads as touched — which is not a crash but a permanent
   * protection racket: `Reconciler` rule 4 then keeps every row the rules stop producing, forever,
   * and the review queue fills with clutter nobody can clear. It compiles, it throws nothing, and
   * it is invisible in a meeting with one item.
   *
   * Every existing test of the edit signal has exactly one item in the meeting —
   * `BackfillEditsTest.aCorrectedItemIsProtectedFromARuleThatNoLongerExtractsIt` and
   * `ItemsDbTest` alike — so none of them could see it. RULE items rather than typed ones,
   * because a typed row is `confirmed` and therefore touched by definition: it saturates the
   * predicate and cannot tell you which signal set it.
   */
  @Test fun theEditSignalMarksOnlyTheItemItBelongsTo() {
    inAMeeting { m ->
      db.backfillItems(m)
      val before = db.items(m)
      assertTrue("the fixture needs at least two rule items", before.size >= 2)
      assertTrue("a rule item was touched before anything touched it", before.none { it.touched })

      db.putEdit(m, "item", before[0].id, "Corrected by hand")

      val after = db.items(m)
      assertTrue("the corrected item does not read as touched", after.first { it.id == before[0].id }.touched)
      assertEquals(
        "one correction marked more than one item",
        1, after.count { it.touched },
      )
    }
  }

  /**
   * TWO ROWS WITH IDENTICAL TEXT BOTH TAKE THE CORRECTION, which is documented and was unpinned.
   *
   * `carryEditsOntoItems` matches on `ItemKey.of(item.text)`, so two items whose text hashes to
   * one key both receive it. Task 11 reworded that method's `@return` for exactly this — "how many
   * ITEMS received a carried correction, not how many corrections moved" — and then nothing
   * asserted it, which left a documented fan-out looking like a bug to whoever read the count
   * next. It is the wanted behaviour: it is what the OLD reader did, hashing each minute of the
   * kind separately and matching them all, and a person who corrects one of two identical lines
   * means both.
   *
   * Typed rows are the cheapest way to get two items with byte-identical text, and after the
   * generator fix above they are also two distinct rows rather than a UNIQUE violation.
   */
  @Test fun twoRowsWithIdenticalTextBothTakeTheCorrection() {
    inAMeeting { m ->
      typeAMinute(m, "action", "Book the venue — Priya")
      typeAMinute(m, "action", "Book the venue — Priya")
      db.putEdit(m, "minute", ItemKey.of("Book the venue — Priya"), "Book the hall — Priya")

      db.carryUserMinutesOntoItems(m)

      assertEquals("the fan-out is the count of ITEMS, not of corrections", 2, db.carryEditsOntoItems(m))

      val moved = userItems(m)
      assertEquals(2, moved.size)
      val keys = json(
        "SELECT target_key AS key FROM edits WHERE meeting_id=? AND target_kind='item' " +
          "ORDER BY target_key", m,
      )
      assertEquals(2, keys.length())
      assertEquals(
        moved.map { it.id }.sorted(),
        (0 until keys.length()).map { keys.getJSONObject(it).getString("key") }.sorted(),
      )
      // And the one minute-keyed row is gone: the DELETE is by key, so it runs once for both.
      assertEquals(
        0, json("SELECT 1 FROM edits WHERE meeting_id=? AND target_kind='minute'", m).length(),
      )
    }
  }

  /**
   * `backfillItems` does all three in one transaction, in the one order that works.
   *
   * The rows have to become items AFTER `replaceItems` — which deletes and re-inserts every item
   * the meeting has — and BEFORE the tick carry and the correction carry, which both match on
   * `ItemKey.of(item.text)` and so pick the typed rows up for free. Get it wrong in either
   * direction and the typed rows are wiped, or arrive with neither their tick nor their
   * correction, and nothing reports it.
   */
  @Test fun backfillItemsMovesTypedRowsTheirTicksAndTheirCorrectionsInOnePass() {
    inAMeeting { m ->
      typeAMinute(m, "action", "Book the venue — Priya")
      db.exec(
        "INSERT INTO action_done(meeting_id,item_key,done_at) VALUES('$m'," +
          "'${ItemKey.of("Book the venue — Priya")}',1700000000000)",
      )
      db.putEdit(m, "minute", ItemKey.of("Book the venue — Priya"), "Book the hall — Priya")

      db.backfillItems(m)

      val typed = userItems(m).single()
      assertEquals("Book the venue — Priya", typed.text)
      // Rule items landed beside it. "The typed row was wiped" is what `userItems(m).single()`
      // above already catches — it throws on an empty list — so this assertion is about the OTHER
      // half: that the rule pass ran and its output is in the same table.
      assertTrue("the rule pass produced no items beside the typed row", db.items(m).size > 1)
      assertTrue(db.doneItemIds(m).contains(typed.id))
      assertEquals(
        1,
        json(
          "SELECT 1 FROM edits WHERE meeting_id=? AND target_kind='item' AND target_key=?",
          m, typed.id,
        ).length(),
      )
      assertEquals("the minutes row it came from is still there", 0, userMinutes(m))
    }
  }

  /** How many `minutes` rows of this meeting a PERSON wrote, of any kind. */
  private fun userMinutes(meetingId: String): Int {
    val rows = minuteRows(meetingId)
    var n = 0
    for (i in 0 until rows.length()) if (rows.getJSONObject(i).getString("source") == "user") n++
    return n
  }

  // ---- What it must not do ---------------------------------------------------------------------

  /**
   * Prose stays in `minutes`.
   *
   * A hand-written summary, write-up or headline is a DOCUMENT: one per meeting, no anchor, no
   * tick, no provenance. Moved into `items` it would appear as a list row on the MOM tab holding
   * the entire write-up, and `db.addUserMinute` — which still writes these three — would have
   * nothing to read it back.
   */
  @Test fun handWrittenProseIsNotMoved() {
    inAMeeting { m ->
      typeAMinute(m, "summary", "A short meeting about the beta.")
      typeAMinute(m, "narrative", "We talked about the beta, then about the venue.")
      typeAMinute(m, "headline", "Beta and venue")
      typeAMinute(m, "decision", "Ship the beta to the pilot group")

      assertEquals(1, db.carryUserMinutesOntoItems(m))

      assertEquals("Ship the beta to the pilot group", userItems(m).single().text)
      val left = minuteRows(m)
      assertEquals(3, left.length())
      val kinds = (0 until left.length()).map { left.getJSONObject(it).getString("kind") }
      assertEquals(listOf("summary", "narrative", "headline"), kinds)
    }
  }

  /**
   * Running it twice changes nothing, and it is idempotent FROM THE DATA rather than from a marker.
   *
   * That is what makes it affordable to call on every open, which is how it reaches the two
   * populations `backfillItems` never visits again — a meeting the Task 8b sweep has already
   * stamped, and one the pipeline wrote items for directly. After a move there is no `source='user'`
   * row of an item kind left to move.
   */
  @Test fun runningTheMoveTwiceChangesNothing() {
    inAMeeting { m ->
      typeAMinute(m, "decision", "Ship the beta to the pilot group")
      typeAMinute(m, "summary", "A short meeting about the beta.")
      assertEquals(1, db.carryUserMinutesOntoItems(m))

      val after = userItems(m).single()
      assertEquals(0, db.carryUserMinutesOntoItems(m))

      assertEquals(listOf(after.id), userItems(m).map { it.id })
      assertEquals("the prose row was swept on a later pass", 1, minuteRows(m).length())
    }
  }

  /**
   * A typed row survives the very next reprocess, which is rule 1 doing its job.
   *
   * The reason `gen_version` has to come across, stated as an outcome rather than as a column
   * value: the rules will never extract a sentence nobody said, so a typed row that arrived
   * labelled `rules@1` is deleted by rule 4 the first time anything reprocesses the meeting.
   */
  @Test fun aMovedRowSurvivesAReprocess() {
    inAMeeting { m ->
      typeAMinute(m, "decision", "Ship the beta to the pilot group")
      db.carryUserMinutesOntoItems(m)
      val before = userItems(m).single()

      db.replaceItems(m, Minutes.RULES_GEN, Minutes.extractItems(db.utterances(m), db.speakers(m)))
      db.replaceItems(m, Minutes.RULES_GEN, emptyList())

      val after = userItems(m).single()
      assertEquals(before.id, after.id)
      assertEquals(before.text, after.text)
      assertEquals(before.createdAt, after.createdAt)
      assertEquals(AudioDb.Gen.NO_ANCHOR, after.anchorStartMs)
    }
  }

  // ---- The guard the move would otherwise break -----------------------------------------------

  /**
   * A MEETING WHOSE ONLY ITEM IS HAND-TYPED IS STILL MIGRATED, and this is the trap the move sets.
   *
   * `ensureItems` asked "does this meeting have items yet". The move runs before the native load —
   * deliberately, so a phone still downloading libonnxruntime.so does not open a meeting with the
   * person's own notes missing — so it puts an item into a meeting the rules have never run over.
   * Under the old guard that meeting is excluded from `ensureItems` and from the sweep FOREVER: it
   * never gains its rule items, and because the tabs' fallback also asked "are there items" it
   * would show the one line the person typed and nothing else.
   *
   * The question every one of those guards actually means is "have the RULES produced items", and
   * a row somebody typed is not evidence that they have.
   */
  @Test fun aMeetingWhoseOnlyItemIsTypedIsStillMigrated() {
    inAMeeting { m ->
      typeAMinute(m, "decision", "Ship the beta to the pilot group")
      db.carryUserMinutesOntoItems(m)
      assertEquals(1, db.items(m).size)

      assertTrue("ensureItems refused a meeting the rules have never run over", db.ensureItems(m) > 0)

      assertTrue(db.items(m).any { it.genVersion == Minutes.RULES_GEN })
      assertEquals(1, userItems(m).size)
    }
  }

  /** ...and the library sweep has to select it for the same reason. */
  @Test fun theSweepStillSelectsAMeetingWhoseOnlyItemIsTyped() {
    inAMeeting { m ->
      typeAMinute(m, "decision", "Ship the beta to the pilot group")
      db.carryUserMinutesOntoItems(m)

      assertTrue(
        "the backlog dropped a meeting the rules have never run over",
        db.unmigratedMeetings(200).contains(m),
      )

      db.ensureItems(m)
      assertFalse("a migrated meeting stayed in the backlog", db.unmigratedMeetings(200).contains(m))
    }
  }

  /**
   * THE ENTRY POINT EVERY READER PASSES THROUGH, and the meeting only it can reach.
   *
   * `backfillItems` runs once per meeting and never again: a meeting the Task 8b sweep has already
   * stamped `items_migrated_at`, and one the pipeline wrote items for directly, are both finished
   * with it forever. Both can hold typed rows, and on a library swept before this build was
   * installed they are the ONLY meetings that hold them. So `StorageModule.ensureItems` carries as
   * well — before `NativeBridge.ensureLoaded`, because the move is pure SQL and a phone still
   * downloading libonnxruntime.so must not open every meeting with the person's own notes missing.
   *
   * Driven through the bridge method rather than through `AudioDb` directly, because the ordering
   * inside it is the thing under test: the typed rows have to become items BEFORE
   * `carryEditsOntoItems` runs, or a correction on one has no item to find.
   */
  @Test fun aTypedRowIsCarriedForAMeetingTheMigrationWillNeverVisitAgain() {
    inAMeeting { m ->
      // Migrate it first, so it is stamped and AudioDb.ensureItems is finished with it forever...
      db.backfillItems(m)
      // ...and only THEN does a typed row turn up, exactly as it does on a phone whose library was
      // swept before this build was installed.
      typeAMinute(m, "decision", "Ship the beta to the pilot group")
      db.putEdit(m, "minute", ItemKey.of("Ship the beta to the pilot group"), "Ship it to everyone")

      val promise = RecordingPromise()
      StorageModule(NoReactContext(ctx)).ensureItems(m, promise)

      assertNull("the bridge rejected", promise.rejection)
      val moved = userItems(m).single()
      assertEquals("Ship the beta to the pilot group", moved.text)
      assertEquals(0, userMinutes(m))
      val edits = json(
        "SELECT target_kind AS kind,target_key AS key FROM edits WHERE meeting_id=?", m,
      )
      assertEquals(1, edits.length())
      assertEquals(
        "the typed row became an item after the correction carry had already run",
        "item", edits.getJSONObject(0).getString("kind"),
      )
      assertEquals(moved.id, edits.getJSONObject(0).getString("key"))
    }
  }

  /** A meeting with nothing typed pays one scan and writes nothing. */
  @Test fun aMeetingWithNothingTypedIsUntouched() {
    inAMeeting { m ->
      db.backfillItems(m)
      val before = db.items(m).map { it.id }

      assertEquals(0, db.carryUserMinutesOntoItems(m))

      assertEquals(before, db.items(m).map { it.id })
      assertNotNull(before.firstOrNull())
      assertNull(userItems(m).firstOrNull())
    }
  }
}
