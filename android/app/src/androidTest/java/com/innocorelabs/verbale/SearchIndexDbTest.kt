package com.innocorelabs.verbale

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.pipeline.DraftMinute
import com.innocorelabs.verbale.pipeline.Minutes
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The search index's bookkeeping against the real SQLCipher database (sub-project 5).
 *
 * Two known defects from the spine's day and the vector table's lifecycle: a rule decision was a
 * card twice (once from `minutes`, once from `items`); the FTS backlog answered "1" for a library
 * of any size; and search_vec, having no foreign key on purpose, must be deleted by hand and its
 * marker reset by every writer of words. Written 16 Sep with the phone away; run on the Pixel.
 */
@RunWith(AndroidJUnit4::class)
class SearchIndexDbTest {
  private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
  private val db = AudioDb.get(ctx)

  private fun inAMeeting(body: (String) -> Unit) {
    val m = "test-searchindex-" + System.nanoTime()
    db.insertMeeting(m, "Search index test", System.currentTimeMillis(), "free", "/dev/null")
    try {
      body(m)
    } finally {
      db.deleteMeeting(m)
    }
  }

  private fun hits(m: String, term: String): List<String> {
    val all = JSONArray(db.searchJson(ctx, term))
    val out = ArrayList<String>()
    for (i in 0 until all.length()) {
      val row = all.getJSONObject(i)
      if (row.getString("meetingId") == m) out.add(row.getString("kind"))
    }
    return out
  }

  private fun aDecision() = Minutes.Item(
    "decision", "We agreed to ship on Monday",
    listOf(Minutes.Source("u1", 61_000L, 64_000L, 0, 27)), 61_000L, 64_000L,
  )

  private fun one(sql: String, vararg args: String): JSONObject? =
    JSONArray(db.rawQueryJson(sql, arrayOf<String?>(*args))).let { if (it.length() == 0) null else it.getJSONObject(0) }

  private fun embeddedAt(m: String): Long? =
    one("SELECT embedded_at AS t FROM meetings WHERE id=?", m)?.let { if (it.isNull("t")) null else it.getLong("t") }

  private fun vecCount(m: String): Int = one("SELECT count(*) AS n FROM search_vec WHERE meeting_id=?", m)?.getInt("n") ?: 0

  /** The pipeline's order: minutes first, then items. The decision must be one card at the end. */
  @Test fun aRuleDecisionIsOneCardNotTwo() {
    inAMeeting { m ->
      db.replaceMinutes(m, "rule", listOf(DraftMinute("decision", "\"We agreed to ship on Monday\"")))
      assertEquals("before items exist the minutes row is the only card", listOf("minute"), hits(m, "agreed to ship"))
      db.replaceItems(m, "rules@1", listOf(aDecision()))
      assertEquals("the same decision from both tables", listOf("item"), hits(m, "agreed to ship"))
      db.reindexMeeting(m)
      assertEquals("a reindex brought the duplicate back", listOf("item"), hits(m, "agreed to ship"))
    }
  }

  @Test fun theBacklogIsACountNotAFlag() {
    inAMeeting { a ->
      inAMeeting { b ->
        for (m in listOf(a, b)) {
          db.replaceUtterancesJson(m, """[{"start_ms":0,"end_ms":1000,"text":"hello there"}]""")
          db.exec("DELETE FROM search_fts WHERE meeting_id='$m'")
        }
        assertTrue("two unindexed meetings must count as at least two", db.unindexedCount() >= 2)
        assertTrue(db.unindexedMeetings(1).size == 1)
      }
    }
  }

  @Test fun everyWriterOfWordsResetsTheEmbeddingMarker() {
    inAMeeting { m ->
      db.replaceUtterancesJson(m, """[{"start_ms":0,"end_ms":1000,"text":"hello there"}]""")
      db.stampEmbedded(m)
      assertTrue(embeddedAt(m) != null)
      db.replaceUtterancesJson(m, """[{"start_ms":0,"end_ms":1000,"text":"hello again"}]""")
      assertNull("a re-transcription kept the marker", embeddedAt(m))

      db.stampEmbedded(m)
      db.replaceItems(m, "rules@1", listOf(aDecision()))
      assertNull("new items kept the marker", embeddedAt(m))

      db.stampEmbedded(m)
      db.replaceMinutes(m, "llm", listOf(DraftMinute("summary", "\"A summary\"", "llm")))
      assertNull("a new summary kept the marker", embeddedAt(m))

      db.stampEmbedded(m)
      db.replaceMinutes(m, "rule", listOf(DraftMinute("decision", "\"not a summary\"")))
      assertTrue("a minutes write with no summary need not unstamp", embeddedAt(m) != null)

      db.reindexMeeting(m)
      assertNull("a reindex (what a restore runs) kept the marker", embeddedAt(m))
    }
  }

  @Test fun deletingAMeetingDeletesItsVectorsByHand() {
    val m = "test-searchindex-" + System.nanoTime()
    db.insertMeeting(m, "Search index test", System.currentTimeMillis(), "free", "/dev/null")
    db.insertVecs(
      m,
      listOf(AudioDb.VecRow("turn", "u1", 0, 1000, null, "hello", 1L, ByteArray(388), "embed-bge-small")),
    )
    assertEquals(1, vecCount(m))
    db.deleteMeeting(m)
    assertEquals("search_vec has no foreign key; deleteMeeting must sweep it", 0, vecCount(m))
  }

  @Test fun theVectorDiffIsByWordsAndMoment() {
    inAMeeting { m ->
      db.insertVecs(
        m,
        listOf(
          AudioDb.VecRow("turn", "u1", 0, 1000, null, "hello", 11L, ByteArray(388), "embed-bge-small"),
          AudioDb.VecRow("turn", "u2", 1000, 2000, null, "hello", 11L, ByteArray(388), "embed-bge-small"),
        ),
      )
      assertEquals(setOf(AudioDb.VecKey(11L, "u1"), AudioDb.VecKey(11L, "u2")), db.vecKeys(m))
      db.deleteVecs(m, setOf(AudioDb.VecKey(11L, "u2")))
      assertEquals(setOf(AudioDb.VecKey(11L, "u1")), db.vecKeys(m))
    }
  }
}
