package com.innocorelabs.verbale

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.billing.LicenceStore
import com.innocorelabs.verbale.pipeline.VecCodec
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Phase 4 (remembered voices) end to end on the phone's real SQLCipher database.
 *
 * The full remember → fold → suggest → answer → forget cycle, using hand-made unit vectors so the
 * match rule's thresholds are pinned at the angles the brief describes (5° → suggested, 60° → null).
 * The trial is granted and restored, and voices_remember is set and restored, so the developer's
 * phone is left exactly as it was.
 */
@RunWith(AndroidJUnit4::class)
class PeopleDbTest {
  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
  private val db = AudioDb.get(ctx)
  private val made = ArrayList<String>()

  private val trialKeys = listOf("trial_started_at", "trial_summaries_used", "trial_ended_at")
  private var savedTrial: List<String?>? = null
  private var savedRemember: String? = null

  @Before fun grantTrialAndSetVoices() {
    savedTrial = trialKeys.map { db.getSetting(it) }
    db.putSetting("trial_started_at", LicenceStore.now(ctx).toString())
    db.putSetting("trial_summaries_used", "0")
    db.putSetting("trial_ended_at", "0")
    savedRemember = db.getSetting("voices_remember")
    db.putSetting("voices_remember", "1")
  }

  @After fun restoreTrialAndVoices() {
    savedTrial?.let { keys ->
      trialKeys.zip(keys).forEach { (key, value) -> db.putSetting(key, value ?: "0") }
    }
    savedRemember?.let { db.putSetting("voices_remember", it) }
      ?: db.exec("DELETE FROM settings WHERE key='voices_remember'")
    made.forEach { db.deleteMeeting(it) }
    db.forgetVoices()
  }

  private fun meeting(): String {
    val id = "peopledb-" + System.nanoTime()
    db.insertMeeting(id, "PeopleDb test", System.currentTimeMillis(), "pro", "/dev/null")
    made.add(id)
    db.replaceUtterancesJson(
      id,
      """[{"start_ms":0,"end_ms":2000,"text":"one"},{"start_ms":3000,"end_ms":5000,"text":"two"}]""",
    )
    return id
  }

  /** Two speakers (cluster 0 and 1) over the two utterances. Returns the two speaker ids. */
  private fun twoSpeakers(m: String): Pair<String, String> {
    db.assignSpeakers(m, longArrayOf(0, 3000), longArrayOf(2000, 5000), intArrayOf(0, 1))
    val arr = JSONArray(db.rawQueryJson(
      "SELECT id FROM speakers WHERE meeting_id=? ORDER BY cluster_label", arrayOf(m),
    ))
    return Pair(arr.getJSONObject(0).getString("id"), arr.getJSONObject(1).getString("id"))
  }

  /** A unit vector at `deg` degrees from [1, 0]. */
  private fun vAt(deg: Double): FloatArray {
    val r = Math.toRadians(deg)
    return floatArrayOf(cos(r).toFloat(), sin(r).toFloat())
  }

  /** Parse a hex string (from SQLite's hex()) into a byte array, then decode a voice BLOB. */
  private fun personVoice(name: String): FloatArray {
    val hex = JSONArray(db.rawQueryJson(
      "SELECT hex(voice) AS voice_hex FROM people WHERE name=? COLLATE NOCASE", arrayOf(name),
    )).getJSONObject(0).getString("voice_hex")
    val bytes = ByteArray(hex.length / 2)
    for (i in bytes.indices) bytes[i] = hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
    return VecCodec.decode(bytes)
  }

  private fun norm(v: FloatArray): Double {
    var s = 0.0
    for (x in v) s += x.toDouble() * x.toDouble()
    return sqrt(s)
  }

  @Test
  fun setSpeakerVoices_sets_both_null_for_all_zero_row() {
    val m = meeting()
    twoSpeakers(m)
    // dim=2, S0=[1,0], S1=[0,1], S2=zero (phantom cluster not in tri, but row still written as zeros)
    db.setSpeakerVoices(m, 2, floatArrayOf(2f, 1f, 0f, 0f, 1f, 0f, 0f, 0f))
    assertEquals("S0 should have a voice", 1, db.count("SELECT count(*) FROM speakers WHERE meeting_id='$m' AND cluster_label='S0' AND voice IS NOT NULL"))
    assertEquals("S1 should have a voice", 1, db.count("SELECT count(*) FROM speakers WHERE meeting_id='$m' AND cluster_label='S1' AND voice IS NOT NULL"))
    assertEquals("S2 all-zero row should be NULL", 0, db.count("SELECT count(*) FROM speakers WHERE meeting_id='$m' AND cluster_label='S2' AND voice IS NOT NULL"))
  }

  @Test
  fun remember_fold_suggest_answer_forget_cycle() {
    // ---- 1. Remember Priya on meeting 1 → people row, samples=1 ----
    val m1 = meeting()
    val (sp1, sp2) = twoSpeakers(m1)
    db.setSpeakerVoices(m1, 2, floatArrayOf(2f, 1f, 0f, 0f, 1f))
    val r1 = JSONObject(db.rememberVoice(sp1, "Priya", ctx))
    assertTrue("should remember", r1.getBoolean("remembered"))
    assertEquals("one people row", 1, db.count("SELECT count(*) FROM people"))
    assertEquals("samples=1", 1, samplesOf("Priya"))

    // ---- 2. Second meeting, near-parallel (5°) → samples=2, centroid unit length ----
    val m2 = meeting()
    val (sp1b, sp2b) = twoSpeakers(m2)
    val v = vAt(5.0)
    db.setSpeakerVoices(m2, 2, floatArrayOf(2f, v[0], v[1], 0f, 1f))
    val r2 = JSONObject(db.rememberVoice(sp1b, "Priya", ctx))
    assertTrue("should re-remember", r2.getBoolean("remembered"))
    assertEquals("samples=2", 2, samplesOf("Priya"))
    assertEquals("centroid is a unit vector", 1.0, norm(personVoice("Priya")), 1e-3)

    // ---- 3. rememberVoice with a default name → default_name ----
    val r3 = JSONObject(db.rememberVoice(sp2b, "Speaker 3", ctx))
    assertFalse("should not remember a default name", r3.getBoolean("remembered"))
    assertEquals("default_name", r3.getString("reason"))
    assertEquals("still one person", 1, db.count("SELECT count(*) FROM people"))

    // ---- 4. Setting off → off ----
    db.putSetting("voices_remember", "0")
    val r4 = JSONObject(db.rememberVoice(sp2b, "Sam", ctx))
    assertFalse("should not remember with setting off", r4.getBoolean("remembered"))
    assertEquals("off", r4.getString("reason"))
    db.putSetting("voices_remember", "1")

    // ---- 5. suggestPeople: 5° matches, 60° doesn't ----
    val m3 = meeting()
    db.assignSpeakers(m3, longArrayOf(0, 3000), longArrayOf(2000, 5000), intArrayOf(0, 1))
    val arr = JSONArray(db.rawQueryJson(
      "SELECT id, cluster_label FROM speakers WHERE meeting_id=? ORDER BY cluster_label", arrayOf(m3),
    ))
    val s3_0 = arr.getJSONObject(0).getString("id")
    val s3_1 = arr.getJSONObject(1).getString("id")
    val near = vAt(5.0)   // 5° from Priya's [1,0] → cosine ≈ 0.996
    val far = vAt(60.0)   // 60° → cosine = 0.50
    db.setSpeakerVoices(m3, 2, floatArrayOf(2f, near[0], near[1], far[0], far[1]))
    db.suggestPeople(m3)

    val sug = JSONArray(db.rawQueryJson(
      "SELECT cluster_label, suggested_person IS NOT NULL AS has_sug, " +
        "(SELECT name FROM people WHERE id=suggested_person) AS sug_name " +
        "FROM speakers WHERE meeting_id=? ORDER BY cluster_label",
      arrayOf(m3),
    ))
    assertTrue("S0 should be suggested", sug.getJSONObject(0).getInt("has_sug") == 1)
    assertEquals("S0's suggestion is Priya", "Priya", sug.getJSONObject(0).getString("sug_name"))
    assertFalse("S1 should not be suggested", sug.getJSONObject(1).getInt("has_sug") == 1)

    // ---- 6. answerSuggestion(accept) → display_name=Priya, samples=3, suggestion cleared ----
    val r6 = JSONObject(db.answerSuggestion(s3_0, true))
    assertEquals("display_name is now Priya's", "Priya", r6.getString("name"))
    assertEquals("display_name written to speaker", 1, db.count("SELECT count(*) FROM speakers WHERE id='$s3_0' AND display_name='Priya'"))
    assertEquals("suggestion cleared", 0, db.count("SELECT count(*) FROM speakers WHERE id='$s3_0' AND suggested_person IS NOT NULL"))
    assertEquals("samples=3 after accept", 3, samplesOf("Priya"))

    // ---- 7. forgetVoices → people empty, every voice NULL ----
    db.forgetVoices()
    assertEquals("no people left", 0, db.count("SELECT count(*) FROM people"))
    assertEquals("no speaker voices left", 0, db.count("SELECT count(*) FROM speakers WHERE meeting_id='$m3' AND voice IS NOT NULL"))
  }

  @Test
  fun answerSuggestion_dismiss_clears_suggestion_only() {
    val m = meeting()
    val (sp1, sp2) = twoSpeakers(m)
    db.setSpeakerVoices(m, 2, floatArrayOf(2f, 1f, 0f, 0f, 1f))
    db.rememberVoice(sp1, "Priya", ctx)

    val m2 = meeting()
    twoSpeakers(m2)
    db.setSpeakerVoices(m2, 2, floatArrayOf(2f, vAt(5.0)[0], vAt(5.0)[1], 0f, 1f))
    db.suggestPeople(m2)
    val arr = JSONArray(db.rawQueryJson(
      "SELECT id, cluster_label FROM speakers WHERE meeting_id=? ORDER BY cluster_label", arrayOf(m2),
    ))
    val s0 = arr.getJSONObject(0).getString("id")
    assertEquals("S0 has a suggestion before dismiss", 1, db.count("SELECT count(*) FROM speakers WHERE id='$s0' AND suggested_person IS NOT NULL"))

    val r = JSONObject(db.answerSuggestion(s0, false))
    assertEquals("display_name unchanged on dismiss", "Speaker 1", r.getString("name"))
    assertEquals("suggestion cleared", 0, db.count("SELECT count(*) FROM speakers WHERE id='$s0' AND suggested_person IS NOT NULL"))
    assertEquals("samples unchanged at 1", 1, samplesOf("Priya"))
  }

  /** samples for a person by name, -1 if not found. */
  private fun samplesOf(name: String): Int {
    val arr = JSONArray(db.rawQueryJson(
      "SELECT samples FROM people WHERE name=? COLLATE NOCASE", arrayOf(name),
    ))
    return if (arr.length() > 0) arr.getJSONObject(0).getInt("samples") else -1
  }
}
