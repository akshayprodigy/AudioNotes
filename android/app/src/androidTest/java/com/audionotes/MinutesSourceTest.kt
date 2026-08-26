package com.audionotes

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.audionotes.data.AudioDb
import com.audionotes.pipeline.DraftMinute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/**
 * Writing LLM minutes must not delete the rule-based ones.
 *
 * Before this, db.replaceMinutes deleted every row for the meeting, so an LLM pass that found 2
 * actions destroyed the 7 the rules had extracted with verbatim quotes — measured on the real
 * NeoSym recording, 2026-08-26. The rules are extractive and every item they produce can be traced
 * to something that was said; the LLM writes prose and carries no such guarantee. Both tiers now
 * coexist, and this is the test that keeps them that way.
 */
@RunWith(AndroidJUnit4::class)
class MinutesSourceTest {
  private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

  private fun newMeeting(db: AudioDb): String {
    val id = "test-" + UUID.randomUUID()
    db.insertMeeting(id, "source test", System.currentTimeMillis(), "free", "/dev/null")
    return id
  }

  @Test
  fun writing_one_source_leaves_the_other_alone() {
    val db = AudioDb.get(ctx)
    val id = newMeeting(db)
    try {
      db.replaceMinutes(id, "rule", listOf(
        DraftMinute("action", "rule action", "rule"),
        DraftMinute("question", "rule question", "rule"),
      ))
      db.replaceMinutes(id, "llm", listOf(DraftMinute("summary", "llm summary", "llm")))

      assertEquals(2, db.minutesBySource(id, "rule").size)
      assertEquals(1, db.minutesBySource(id, "llm").size)

      // Rewriting the rule rows must not touch the llm row. This is the case that used to fail:
      // a speaker merge rebuilds the rule minutes and silently took the narrative with it.
      db.replaceMinutes(id, "rule", listOf(DraftMinute("action", "new rule action", "rule")))
      assertEquals(1, db.minutesBySource(id, "rule").size)
      assertEquals("new rule action", db.minutesBySource(id, "rule")[0].content)
      assertEquals(1, db.minutesBySource(id, "llm").size)
      assertEquals("llm summary", db.minutesBySource(id, "llm")[0].content)

      // ...and the reverse: narrating must not cost the meeting its grounded items.
      db.replaceMinutes(id, "llm", listOf(DraftMinute("summary", "second summary", "llm")))
      assertEquals(1, db.minutesBySource(id, "rule").size)
      assertEquals("second summary", db.minutesBySource(id, "llm")[0].content)
    } finally {
      db.deleteMeeting(id)
    }
  }

  @Test
  fun notes_checkpoint_round_trips_and_clears() {
    val db = AudioDb.get(ctx)
    val id = newMeeting(db)
    try {
      assertTrue("a fresh meeting has no notes", db.notes(id).isEmpty())

      db.putNote(id, 0, "first digest")
      db.putNote(id, 2, "third digest")
      assertEquals(mapOf(0 to "first digest", 2 to "third digest"), db.notes(id))

      // Re-running a chunk overwrites rather than duplicating: the primary key is
      // (meeting_id, chunk_index), so a retry cannot leave two notes for one chunk.
      db.putNote(id, 0, "first digest, again")
      assertEquals(2, db.notes(id).size)
      assertEquals("first digest, again", db.notes(id)[0])

      db.clearNotes(id)
      assertTrue("notes should be gone after clearNotes", db.notes(id).isEmpty())
    } finally {
      db.deleteMeeting(id)
    }
  }

  @Test
  fun summary_line_starts_null_and_survives_a_write() {
    val db = AudioDb.get(ctx)
    val id = newMeeting(db)
    try {
      assertNull("summary_line should start empty", db.summaryLine(id))
      db.setSummaryLine(id, "Vendor codes moving from PHP to SAP.")
      assertEquals("Vendor codes moving from PHP to SAP.", db.summaryLine(id))
    } finally {
      db.deleteMeeting(id)
    }
  }

  @Test
  fun deleting_a_meeting_takes_its_notes_with_it() {
    val db = AudioDb.get(ctx)
    val id = newMeeting(db)
    db.putNote(id, 0, "digest")
    db.replaceMinutes(id, "llm", listOf(DraftMinute("summary", "s", "llm")))
    db.deleteMeeting(id)

    // ON DELETE CASCADE only fires with foreign_keys=ON, which AudioDb.open sets. Without it these
    // rows outlive the meeting and the next id collision resurrects someone else's notes.
    assertTrue("notes outlived the meeting", db.notes(id).isEmpty())
    assertTrue("minutes outlived the meeting", db.minutesBySource(id, "llm").isEmpty())
  }
}
