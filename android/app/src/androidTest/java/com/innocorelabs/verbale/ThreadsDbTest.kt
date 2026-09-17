package com.innocorelabs.verbale

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.billing.LicenceStore
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.pipeline.Minutes
import com.innocorelabs.verbale.pipeline.VecCodec
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

/**
 * Phase 3 (thread memory): the SQL half `AudioDb.threadJson` only SQLite (plus the real
 * `DecisionLinks`/`VecCodec`) can answer — the tag join, the open/decisions assembly, and the
 * Pro gate running before any table is touched. Real SQLCipher, real `replaceItems`
 * (Reconciler included), real vectors.
 */
@RunWith(AndroidJUnit4::class)
class ThreadsDbTest {
  private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
  private val db = AudioDb.get(ctx)
  private val made = ArrayList<String>()

  // Mirrors NativePipelineTest.grantTrial/restoreTrial exactly, so a developer's real trial or
  // subscription is never spent by running this class.
  private val trialKeys = listOf("trial_started_at", "trial_summaries_used", "trial_ended_at")
  private var savedTrial: List<String?>? = null

  @Before
  fun grantTrial() {
    savedTrial = trialKeys.map { db.getSetting(it) }
    db.putSetting("trial_started_at", LicenceStore.now(ctx).toString())
    db.putSetting("trial_summaries_used", "0")
    db.putSetting("trial_ended_at", "0")
  }

  @After
  fun restoreTrialAndCleanUp() {
    val saved = savedTrial
    if (saved != null) trialKeys.zip(saved).forEach { (key, value) -> db.putSetting(key, value ?: "0") }
    made.forEach { db.deleteMeeting(it) }
  }

  private fun meeting(title: String, createdAt: Long): String {
    val id = "test-thread-$title-" + System.nanoTime()
    db.insertMeeting(id, title, createdAt, "free", "/dev/null")
    made.add(id)
    return id
  }

  private fun tag(meetingId: String, name: String) {
    db.exec("INSERT INTO tags(meeting_id, name) VALUES('$meetingId','$name')")
  }

  private fun archive(meetingId: String) {
    db.exec("UPDATE meetings SET archived_at = ${System.currentTimeMillis()} WHERE id = '$meetingId'")
  }

  /** An action and a decision, through the real rule-reconciliation path. Returns their ids. */
  private fun items(meetingId: String, actionText: String, decisionText: String): Pair<String, String> {
    db.replaceItems(
      meetingId, Minutes.RULES_GEN,
      listOf(
        Minutes.Item("action", actionText, emptyList(), 0L, 0L),
        Minutes.Item("decision", decisionText, emptyList(), 0L, 0L),
      ),
    )
    val stored = db.items(meetingId)
    return stored.first { it.kind == "action" }.id to stored.first { it.kind == "decision" }.id
  }

  private fun tick(meetingId: String, itemId: String) {
    db.exec("INSERT INTO item_done(meeting_id, item_id, done_at) VALUES('$meetingId','$itemId',${System.currentTimeMillis()})")
  }

  private fun reject(itemId: String) {
    db.exec("UPDATE items SET review = 'rejected' WHERE id = '$itemId'")
  }

  private fun storeVec(meetingId: String, itemId: String, text: String, v: FloatArray) {
    db.insertVecs(
      meetingId,
      listOf(AudioDb.VecRow("item", itemId, 0L, 0L, null, text, 0L, VecCodec.encode(v), "test")),
    )
  }

  @Test fun threadJsonAssemblesMeetingsOpenAndDecisionsForOneTag() {
    val now = System.currentTimeMillis()
    val day = 86_400_000L
    val m1At = now - 14 * day // "3 Sep" — oldest
    val m2At = now - 7 * day // "10 Sep" — changes m1's decision
    val m3At = now // "17 Sep" — newest, changes nothing

    val m1 = meeting("Ops weekly (oldest)", m1At)
    val m2 = meeting("Ops weekly (middle)", m2At)
    val m3 = meeting("Ops weekly (newest)", m3At)
    val untagged = meeting("Not in the thread", now)
    val archived = meeting("Ops weekly (archived)", now - 3 * day)
    listOf(m1, m2, m3, archived).forEach { tag(it, "ops") }
    archive(archived)

    val (a1, d1) = items(m1, "Ravi to check with finance (due Friday)", "Vendor codes will be six digits.")
    val (a2, d2) = items(m2, "Priya to draft the mapping table (due tomorrow)", "Existing vendors keep their old codes.")
    val (a3, d3) = items(m3, "Someone to follow up", "We agreed to hire two more testers.")
    val (aUntagged, _) = items(untagged, "Not part of any thread", "Not part of any thread either")
    items(archived, "An archived action", "An archived decision")

    tick(m1, a1) // excluded from `open`: ticked
    reject(a2) // excluded from `open`: rejected
    // a3 stays open. aUntagged is excluded by the tag join alone, regardless of its own state.
    assertTrue(aUntagged.isNotEmpty())

    // Two nearly-parallel unit vectors (15 degrees apart, cosine ~0.966 — well above LINK_COSINE)
    // for the decisions that are "the same decision, changed"; one orthogonal to both for the
    // decision that changes nothing.
    val va = floatArrayOf(1f, 0f)
    val angle = Math.toRadians(15.0)
    val vb = floatArrayOf(cos(angle).toFloat(), sin(angle).toFloat())
    val vc = floatArrayOf(0f, 1f)
    storeVec(m1, d1, "Vendor codes will be six digits.", va)
    storeVec(m2, d2, "Existing vendors keep their old codes.", vb)
    storeVec(m3, d3, "We agreed to hire two more testers.", vc)

    val result = JSONObject(db.threadJson(ctx, "ops"))
    assertFalse(result.has("refusal"))

    val meetings = result.getJSONArray("meetings")
    assertEquals(3, meetings.length())
    assertEquals(m3, meetings.getJSONObject(0).getString("id"))
    assertEquals(m2, meetings.getJSONObject(1).getString("id"))
    assertEquals(m1, meetings.getJSONObject(2).getString("id"))

    val open = result.getJSONArray("open")
    assertEquals(1, open.length())
    assertEquals(a3, open.getJSONObject(0).getString("itemId"))

    val decisions = result.getJSONArray("decisions")
    assertEquals(3, decisions.length())
    assertEquals(d1, decisions.getJSONObject(0).getString("itemId"))
    assertEquals(d2, decisions.getJSONObject(1).getString("itemId"))
    assertEquals(d3, decisions.getJSONObject(2).getString("itemId"))
    assertTrue(decisions.getJSONObject(0).isNull("changes"))
    assertEquals(d1, decisions.getJSONObject(1).getJSONObject("changes").getString("itemId"))
    assertTrue(decisions.getJSONObject(2).isNull("changes"))
  }

  @Test fun threadJsonRefusesWithoutEntitlement() {
    // Written off, the way a real spent trial is: past the window AND no licence token stored.
    db.putSetting("trial_ended_at", LicenceStore.now(ctx).toString())
    val hadToken = db.getSetting("licence_token")
    db.putSetting("licence_token", "")
    try {
      val result = JSONObject(db.threadJson(ctx, "ops"))
      assertEquals("NOT_PRO", result.getString("refusal"))
      assertFalse(result.has("meetings"))
    } finally {
      db.putSetting("licence_token", hadToken ?: "")
    }
  }
}
