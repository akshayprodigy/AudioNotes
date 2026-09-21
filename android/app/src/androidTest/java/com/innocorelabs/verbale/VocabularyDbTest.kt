package com.innocorelabs.verbale

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.pipeline.NativeBridge
import com.innocorelabs.verbale.pipeline.Vocabulary
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Phase 5 (custom vocabulary, dictation) on the phone's real SQLCipher database: a rule corrects a
 * line and keeps the recogniser's wording in text_raw; neither a second pass nor a later rule
 * overwrites that wording;
 * a dictated meeting's spoken marks become marks through the JNI; the mode round-trips.
 *
 * The rule's `heard` is a word no real recording contains ("zorp co"), and every meeting and rule
 * this test makes is deleted after — the developer's own vocabulary is neither read into the
 * assertions (rules are passed explicitly) nor touched.
 */
@RunWith(AndroidJUnit4::class)
class VocabularyDbTest {
  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
  private val db = AudioDb.get(ctx)
  private val meetings = ArrayList<String>()
  private val rules = ArrayList<String>()

  @After fun cleanUp() {
    meetings.forEach { db.deleteMeeting(it) }
    rules.forEach { db.deleteVocabulary(it) }
  }

  private fun meeting(vararg texts: String): String {
    val id = "vocabdb-" + System.nanoTime()
    db.insertMeeting(id, "VocabularyDb test", System.currentTimeMillis(), "pro", "/dev/null")
    meetings.add(id)
    val arr = JSONArray()
    texts.forEachIndexed { i, t ->
      arr.put(JSONObject().put("start_ms", i * 3000L).put("end_ms", i * 3000L + 2000).put("text", t))
    }
    db.replaceUtterancesJson(id, arr.toString())
    return id
  }

  private fun rule(heard: String, meant: String, source: String): String =
    db.putVocabulary(heard, meant, source).also { if (it !in rules) rules.add(it) }

  /** (text, text_raw) per line in time order; text_raw null means the recogniser's wording stands. */
  private fun lines(id: String): List<Pair<String, String?>> {
    val arr = JSONArray(db.rawQueryJson(
      "SELECT text, text_raw FROM utterances WHERE meeting_id=? ORDER BY start_ms", arrayOf(id),
    ))
    return (0 until arr.length()).map { i ->
      val o = arr.getJSONObject(i)
      o.getString("text") to (if (o.isNull("text_raw")) null else o.getString("text_raw"))
    }
  }

  private fun rowsFor(heard: String): JSONArray =
    JSONArray(db.rawQueryJson("SELECT id, meant, source, uses FROM vocabulary WHERE heard=? COLLATE NOCASE", arrayOf(heard)))

  @Test fun rules_apply_and_keep_the_raw_wording() {
    val id = meeting("we sold it to zorp co", "nothing here")
    val rid = rule("zorp co", "Zorp", "typed")
    assertTrue("vocabularyRules() must read the row back", db.vocabularyRules().any { it.heard == "zorp co" && it.meant == "Zorp" })
    assertTrue("vocabularyJson() must carry the row", db.vocabularyJson().contains("\"heard\":\"zorp co\""))
    val mine = listOf(Vocabulary.Rule("zorp co", "Zorp"))

    assertEquals(1, db.applyVocabularyToMeeting(id, null, mine))
    assertEquals(
      listOf("we sold it to Zorp" to "we sold it to zorp co", "nothing here" to null),
      lines(id),
    )
    assertEquals(1, rowsFor("zorp co").getJSONObject(0).getInt("uses"))

    // A second pass changes nothing and — the point of COALESCE — leaves text_raw as it was.
    assertEquals(0, db.applyVocabularyToMeeting(id, null, mine))
    assertEquals("we sold it to zorp co", lines(id)[0].second)

    // Typing "ZORP CO" over an existing "zorp co" replaces its meant and source: one row, same id.
    assertEquals(rid, rule("ZORP CO", "Zorp Ltd", "learned"))
    val row = rowsFor("zorp co")
    assertEquals(1, row.length())
    assertEquals("Zorp Ltd", row.getJSONObject(0).getString("meant"))
    assertEquals("learned", row.getJSONObject(0).getString("source"))
    // Rules run over the CURRENT text, so a line already corrected to "Zorp" is not re-corrected by
    // a rule whose heard is "zorp co" — it already reads "Zorp". text_raw still holds the original.
    assertEquals(0, db.applyVocabularyToMeeting(id, null, listOf(Vocabulary.Rule("zorp co", "Zorp Ltd"))))
    assertEquals("we sold it to Zorp" to "we sold it to zorp co", lines(id)[0])

    // A different rule that DOES match the corrected line rewrites it a second time — and text_raw
    // still holds the wording before the first correction, not "…Zorp": the COALESCE.
    assertEquals(1, db.applyVocabularyToMeeting(id, null, listOf(Vocabulary.Rule("sold", "licensed"))))
    assertEquals("we licensed it to Zorp" to "we sold it to zorp co", lines(id)[0])
  }

  @Test fun dictation_applies_the_marks_and_keeps_raw() {
    NativeBridge.ensureLoaded(ctx)
    val id = meeting("tell finance comma the invoice is late full stop")
    db.setMode(id, "dictation")
    val punctuate = { t: String -> NativeBridge.nativeApplySpokenPunctuation(t) }
    assertEquals(1, db.applyVocabularyToMeeting(id, punctuate, emptyList()))
    assertEquals(
      listOf("Tell finance, the invoice is late." to "tell finance comma the invoice is late full stop"),
      lines(id),
    )
    assertEquals(0, db.applyVocabularyToMeeting(id, punctuate, emptyList()))
  }

  @Test fun mode_round_trips() {
    val id = meeting("one")
    assertNull(db.mode(id))
    db.setMode(id, "dictation")
    assertEquals("dictation", db.mode(id))
    db.setMode(id, null)
    assertNull(db.mode(id))
  }

  @Test fun put_rejects_blank_and_unknown_source() {
    try { db.putVocabulary(" ", "x", "typed"); fail("blank heard must throw") } catch (e: IllegalArgumentException) {}
    try { db.putVocabulary("x", " ", "typed"); fail("blank meant must throw") } catch (e: IllegalArgumentException) {}
    try { db.putVocabulary("x", "y", "guessed"); fail("unknown source must throw") } catch (e: IllegalArgumentException) {}
    assertEquals(0, rowsFor("x").length())
  }
}
