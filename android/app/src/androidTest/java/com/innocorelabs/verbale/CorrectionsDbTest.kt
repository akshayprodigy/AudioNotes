package com.innocorelabs.verbale

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.Corrections
import com.innocorelabs.verbale.pipeline.DraftMinute
import com.innocorelabs.verbale.pipeline.NativeBridge
import com.innocorelabs.verbale.pipeline.Rederive
import org.json.JSONArray
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * F15, the database half: a correction is written through into the line, the index and the
 * embedding stamp follow it, the rule pass re-derives the items through the Reconciler (tick and
 * hand-typed item kept), and a re-transcription re-applies the correction to the new line.
 * The decisions themselves are pinned on the JVM by CorrectionsTest.
 *
 * NOT RUN in the session that wrote it (no phone): it compiles, it is the device stage's to run.
 */
@RunWith(AndroidJUnit4::class)
class CorrectionsDbTest {
  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
  private val db = AudioDb.get(ctx)
  private val created = ArrayList<String>()

  private val TRANSCRIPT = """[
    {"start_ms":61000,"end_ms":64000,"text":"We agreed to ship on Monday."},
    {"start_ms":125000,"end_ms":129000,"text":"I will send the signed contract to Meera by Friday."}
  ]"""

  @After fun cleanUp() {
    for (m in created) runCatching { db.deleteMeeting(m) }
    created.clear()
  }

  private fun seeded(status: String = "done"): String {
    NativeBridge.ensureLoaded(ctx)
    val m = "test-corr-" + System.nanoTime()
    db.insertMeeting(m, "Corrections test", System.currentTimeMillis(), "free", "/dev/null")
    created.add(m)
    db.replaceUtterancesJson(m, TRANSCRIPT)
    db.replaceItems(m, com.innocorelabs.verbale.pipeline.Minutes.RULES_GEN,
      com.innocorelabs.verbale.pipeline.Minutes.extractItems(db.utterances(m), db.speakers(m)))
    db.setStatus(m, status)
    return m
  }

  private fun contractLine(m: String) = db.utterances(m).first { it.text.contains("contract") }

  private fun column(sql: String, vararg args: String): List<String?> {
    val rows = JSONArray(db.rawQueryJson(sql, arrayOf(*args)))
    return (0 until rows.length()).map { rows.getJSONObject(it).opt("v")?.toString()?.takeIf { s -> s != "null" } }
  }

  @Test fun aCorrectionIsWrittenThroughWithTheRawWordingKeptOnce() {
    val m = seeded()
    val line = contractLine(m)
    assertTrue(db.saveCorrection(m, line.id, "I will send the signed contract to Mira by Friday."))
    assertEquals("I will send the signed contract to Mira by Friday.", contractLine(m).text)
    assertEquals(listOf<String?>(line.text), column("SELECT text_raw AS v FROM utterances WHERE id=?", line.id))
    // A second correction must not replace the recogniser's wording with the first correction.
    db.saveCorrection(m, line.id, "I will send the signed contract to Mira by Thursday.")
    assertEquals(listOf<String?>(line.text), column("SELECT text_raw AS v FROM utterances WHERE id=?", line.id))
    assertEquals(
      listOf<String?>("I will send the signed contract to Mira by Thursday."),
      column("SELECT content AS v FROM edits WHERE meeting_id=? AND target_kind='utterance'", m),
    )
  }

  @Test fun theCorrectionIsWhatSearchHoldsAndTheEmbeddingIsUnstamped() {
    val m = seeded()
    db.stampEmbedded(m)
    val line = contractLine(m)
    db.saveCorrection(m, line.id, "I will send the signed contract to Mira by Friday.")
    val indexed = column("SELECT text AS v FROM search_fts WHERE meeting_id=? AND kind='utterance'", m)
    assertTrue(indexed.any { it?.contains("Mira") == true })
    assertFalse(indexed.any { it?.contains("Meera") == true })
    assertEquals(listOf<String?>(null), column("SELECT embedded_at AS v FROM meetings WHERE id=?", m))
  }

  @Test fun revertingRestoresTheRecognisersWording() {
    val m = seeded()
    val line = contractLine(m)
    db.saveCorrection(m, line.id, "I will send the signed contract to Mira by Friday.")
    assertTrue(db.revertCorrection(m, line.id))
    assertEquals(line.text, contractLine(m).text)
    assertEquals(0, db.count("SELECT count(*) FROM edits WHERE meeting_id='$m' AND target_kind='utterance'"))
    assertNull(column("SELECT text_raw AS v FROM utterances WHERE id=?", line.id).single())
  }

  @Test fun theItemFollowsTheCorrectedLineAndKeepsItsTickAndTheHandTypedItem() {
    val m = seeded()
    val action = db.items(m).first { it.kind == "action" }
    assertTrue(action.text.contains("Meera"))
    db.setItemDone(m, action.id, true)
    db.rawQueryJson(
      "INSERT INTO items(id,meeting_id,kind,text,review,gen_version,anchor_start_ms,anchor_end_ms,created_at) " +
        "VALUES('mine-$m',?, 'action','Book the venue — Unassigned','confirmed','user',?,?,0)",
      arrayOf(m, AudioDb.Gen.NO_ANCHOR.toString(), AudioDb.Gen.NO_ANCHOR.toString()),
    )
    db.saveCorrection(m, contractLine(m).id, "I will send the signed contract to Mira by Friday.")
    assertTrue(Rederive.run(ctx, db, m))
    val after = db.items(m)
    val followed = after.first { it.id == action.id }
    assertTrue(followed.text.contains("Mira"))
    assertFalse(followed.text.contains("Meera"))
    assertTrue("the tick stays on the same item", action.id in db.doneItemIds(m))
    assertNotNull("the hand-typed item survives", after.firstOrNull { it.id == "mine-$m" })
    assertTrue(column("SELECT text AS v FROM search_fts WHERE meeting_id=? AND kind='item'", m).any { it?.contains("Mira") == true })
  }

  @Test fun aMeetingStillBeingProcessedIsNotRederivedButIsFlaggedForNextOpen() {
    val m = seeded(status = "asr")
    db.saveCorrection(m, contractLine(m).id, "I will send the signed contract to Mira by Friday.")
    assertFalse(Rederive.run(ctx, db, m))
    assertTrue(db.rederivePending(m))
    db.setStatus(m, "done")
    Rederive.catchUp(ctx, db, m)
    assertFalse(db.rederivePending(m))
    assertTrue(db.items(m).first { it.kind == "action" }.text.contains("Mira"))
  }

  @Test fun aCorrectionMadeBeforeWriteThroughExistedIsCaughtUpOnOpen() {
    val m = seeded()
    val line = contractLine(m)
    db.rawQueryJson(
      "INSERT INTO edits(meeting_id,target_kind,target_key,content,edited_at) VALUES(?,'utterance',?,?,0)",
      arrayOf(m, line.id, "I will send the signed contract to Mira by Friday."),
    )
    Rederive.catchUp(ctx, db, m)
    assertEquals("I will send the signed contract to Mira by Friday.", contractLine(m).text)
    assertTrue(db.items(m).first { it.kind == "action" }.text.contains("Mira"))
  }

  @Test fun theSummaryGoesStaleOnlyWhenOneWasWrittenAndClearsWhenWrittenAgain() {
    val m = seeded()
    val line = contractLine(m)
    db.saveCorrection(m, line.id, "I will send the signed contract to Mira by Friday.")
    assertFalse("no written summary, nothing to go stale", db.narrationStale(m))
    db.replaceMinutes(m, "llm", listOf(DraftMinute("summary", "They agreed to ship.", "llm")))
    db.saveCorrection(m, line.id, "I will send the signed contract to Mira by Thursday.")
    assertTrue(db.narrationStale(m))
    db.replaceMinutes(m, "llm", listOf(DraftMinute("summary", "They agreed to ship, Mira sends it.", "llm")))
    assertFalse(db.narrationStale(m))
  }

  // ---- Redo -------------------------------------------------------------------------------

  @Test fun aRetranscriptionReappliesTheCorrectionToTheNewLine() {
    val m = seeded()
    db.saveCorrection(m, contractLine(m).id, "I will send the signed contract to Mira by Friday.")
    db.replaceUtterancesJson(m, """[
      {"start_ms":61200,"end_ms":64100,"text":"We agreed to ship on Monday."},
      {"start_ms":125300,"end_ms":129200,"text":"I will send the sign contract to Mayra by Friday."}
    ]""")
    val line = contractLine(m)
    assertEquals("I will send the signed contract to Mira by Friday.", line.text)
    assertEquals(
      listOf<String?>("I will send the sign contract to Mayra by Friday."),
      column("SELECT text_raw AS v FROM utterances WHERE id=?", line.id),
    )
    // The edits row is re-keyed to the new line, so revert still has something to clear.
    assertEquals(
      listOf<String?>(line.id),
      column("SELECT target_key AS v FROM edits WHERE meeting_id=? AND target_kind='utterance'", m),
    )
    assertNull(db.getSetting(Corrections.droppedKey(m)))
  }

  @Test fun aCorrectionWhoseLineIsGoneIsDroppedAndCounted() {
    val m = seeded()
    db.saveCorrection(m, contractLine(m).id, "I will send the signed contract to Mira by Friday.")
    db.replaceUtterancesJson(m, """[{"start_ms":300000,"end_ms":304000,"text":"A different meeting entirely."}]""")
    assertEquals("A different meeting entirely.", db.utterances(m).single().text)
    assertEquals("1", db.getSetting(Corrections.droppedKey(m)))
    assertEquals(0, db.count("SELECT count(*) FROM edits WHERE meeting_id='$m' AND target_kind='utterance'"))
  }
}
