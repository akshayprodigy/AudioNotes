package com.innocorelabs.verbale

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.pipeline.ItemOwner
import com.innocorelabs.verbale.pipeline.Minutes
import com.innocorelabs.verbale.pipeline.NativeBridge
import org.json.JSONArray
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * F14, the database half: a rename reaches the search index and the items' owner record, and the
 * stored text is never rewritten. The pure resolver is covered on the JVM (ItemOwnerTest); what
 * only a real SQLCipher database can show is that `renameSpeaker` records the owner BEFORE the name
 * changes, reindexes after, and that a classifier-written owner is not clobbered.
 *
 * NOT RUN in the session that wrote it (no phone): it compiles, it is the device stage's to run.
 */
@RunWith(AndroidJUnit4::class)
class SpeakerRenameDbTest {
  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
  private val db = AudioDb.get(ctx)
  private val created = ArrayList<String>()

  private val TRANSCRIPT = """[
    {"start_ms":61000,"end_ms":64000,"text":"We agreed to ship on Monday."},
    {"start_ms":125000,"end_ms":129000,"text":"I will send the report by Friday."}
  ]"""

  @After fun cleanUp() {
    for (m in created) runCatching { db.deleteMeeting(m) }
    created.clear()
  }

  /** A meeting whose second line is said by speaker `sp` ("Speaker 1"), with its items extracted. */
  private fun seeded(): Pair<String, String> {
    NativeBridge.ensureLoaded(ctx)
    val m = "test-rename-" + System.nanoTime()
    val sp = "sp-" + System.nanoTime()
    db.insertMeeting(m, "Rename test", System.currentTimeMillis(), "free", "/dev/null")
    created.add(m)
    db.replaceUtterancesJson(m, TRANSCRIPT)
    db.rawQueryJson(
      "INSERT INTO speakers(id,meeting_id,cluster_label,display_name) VALUES(?,?,?,?)",
      arrayOf(sp, m, "S0", "Speaker 1"),
    )
    db.rawQueryJson("UPDATE utterances SET speaker_id=? WHERE meeting_id=?", arrayOf(sp, m))
    db.replaceItems(m, Minutes.RULES_GEN, Minutes.extractItems(db.utterances(m), db.speakers(m)))
    return m to sp
  }

  private fun indexedItemText(m: String): List<String> {
    val rows = JSONArray(db.rawQueryJson("SELECT text FROM search_fts WHERE meeting_id=? AND kind='item'", arrayOf(m)))
    return (0 until rows.length()).map { rows.getJSONObject(it).getString("text") }
  }

  @Test fun theRulePassRecordsTheSpeakerWhoOwnsAFirstPersonAction() {
    val (m, sp) = seeded()
    val action = db.items(m).first { it.kind == "action" }
    assertEquals(sp, ItemOwner.speakerId(action.record?.ownerJson))
    // An owner-only record is not a classifier reading.
    assertFalse(action.classified)
  }

  @Test fun aRenameReachesTheSearchIndexAndLeavesTheStoredTextAlone() {
    val (m, sp) = seeded()
    val before = db.items(m).first { it.kind == "action" }.text
    db.renameSpeaker(sp, "Priya")
    assertEquals("the stored text is untouched", before, db.items(m).first { it.kind == "action" }.text)
    val indexed = indexedItemText(m)
    assertTrue("search holds the new name: $indexed", indexed.any { it.contains("Priya") })
    assertFalse("search still holds the old name: $indexed", indexed.any { it.contains("Speaker 1") })
  }

  /** The population the rename is FOR: items written before owners were recorded. */
  @Test fun anItemFromBeforeOwnersWereRecordedIsAdoptedJustBeforeTheRename() {
    val (m, sp) = seeded()
    db.rawQueryJson("UPDATE items SET owner_json=NULL WHERE meeting_id=?", arrayOf(m))
    assertNull(db.items(m).first { it.kind == "action" }.record)
    db.renameSpeaker(sp, "Priya")
    assertEquals(sp, ItemOwner.speakerId(db.items(m).first { it.kind == "action" }.record?.ownerJson))
    assertTrue(indexedItemText(m).any { it.contains("Priya") })
  }

  /** "<Name> will ..." and a hand-typed row name nobody's speaker row, so no rename touches them. */
  @Test fun aNamedPersonIsNotAdopted() {
    NativeBridge.ensureLoaded(ctx)
    val m = "test-rename-" + System.nanoTime()
    val sp = "sp-" + System.nanoTime()
    db.insertMeeting(m, "Rename test", System.currentTimeMillis(), "free", "/dev/null")
    created.add(m)
    db.replaceUtterancesJson(m, """[{"start_ms":1000,"end_ms":4000,"text":"Maya will send the summary tomorrow."}]""")
    db.rawQueryJson(
      "INSERT INTO speakers(id,meeting_id,cluster_label,display_name) VALUES(?,?,?,?)",
      arrayOf(sp, m, "S0", "Speaker 1"),
    )
    db.rawQueryJson("UPDATE utterances SET speaker_id=? WHERE meeting_id=?", arrayOf(sp, m))
    db.replaceItems(m, Minutes.RULES_GEN, Minutes.extractItems(db.utterances(m), db.speakers(m)))
    db.renameSpeaker(sp, "Priya")
    val item = db.items(m).first { it.kind == "action" }
    assertNull(ItemOwner.speakerId(item.record?.ownerJson))
    assertTrue(item.text.contains("Maya"))
    assertFalse(indexedItemText(m).any { it.contains("Priya") })
  }
}
