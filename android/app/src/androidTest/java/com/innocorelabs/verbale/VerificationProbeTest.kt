package com.innocorelabs.verbale

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import org.json.JSONArray
import org.junit.Test
import org.junit.runner.RunWith

/**
 * NOT a test — a read-only probe for a verification session: prints what the database holds for
 * the newest meetings (status, items with their typed record, vector rows, asks) so the pipeline's
 * result can be read over adb without touching the screen. Runs only by name
 * (`am instrument -e class …VerificationProbeTest`); not in device-verify's CLASSES.
 */
@RunWith(AndroidJUnit4::class)
class VerificationProbeTest {
  @Test fun printTheNewestMeetings() {
    val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    val db = AudioDb.get(ctx)
    val meetings = JSONArray(
      db.rawQueryJson(
        "SELECT id, title, status, duration_ms, embedded_at, tier_used, template, template_source " +
          "FROM meetings ORDER BY created_at DESC LIMIT 3",
        arrayOf(),
      ),
    )
    // Phase 3 (thread memory): the first tag found on the newest tagged meeting, so its thread
    // can be printed once the per-meeting loop below has read every meeting's tags.
    var threadTagToProbe: String? = null
    for (i in 0 until meetings.length()) {
      val m = meetings.getJSONObject(i)
      val id = m.getString("id")
      println("PROBE meeting $id status=${m.optString("status")} title=${m.optString("title")} " +
        "duration=${m.optLong("duration_ms")} embedded_at=${m.opt("embedded_at")} tier=${m.optString("tier_used")} " +
        "template=${m.opt("template")} template_source=${m.opt("template_source")}")
      val tagNames = JSONArray(db.rawQueryJson("SELECT name FROM tags WHERE meeting_id=? ORDER BY name", arrayOf(id)))
        .let { arr -> (0 until arr.length()).map { arr.getJSONObject(it).getString("name") } }
      println("PROBE   tags: $tagNames")
      if (threadTagToProbe == null && tagNames.isNotEmpty()) threadTagToProbe = tagNames.first()
      val items = JSONArray(
        db.rawQueryJson(
          "SELECT id, kind, text, review, item_type, status, owner_json, date_said, date_norm, gen_version " +
            "FROM items WHERE meeting_id=? ORDER BY anchor_start_ms",
          arrayOf(id),
        ),
      )
      for (j in 0 until items.length()) {
        val it = items.getJSONObject(j)
        println("PROBE   item ${it.optString("kind")} review=${it.optString("review")} type=${it.opt("item_type")} " +
          "status=${it.opt("status")} owner=${it.opt("owner_json")} said=${it.opt("date_said")} norm=${it.opt("date_norm")} " +
          "gen=${it.optString("gen_version")} :: ${it.optString("text")}")
      }
      val vec = JSONArray(db.rawQueryJson("SELECT kind, count(*) AS n FROM search_vec WHERE meeting_id=? GROUP BY kind", arrayOf(id)))
      println("PROBE   vectors: $vec")
      println("PROBE   asks: ${db.asksJson(id)}")
      println("PROBE   edits: " + db.rawQueryJson("SELECT target_kind, target_key, content FROM edits WHERE meeting_id=?", arrayOf(id)))
      val utts = db.utterances(id)
      println("PROBE   utterances (${utts.size}): " + utts.take(12).joinToString(" | ") { "${it.startMs / 1000}s ${it.speakerId ?: "?"}: ${it.text}" })
      // Phase 4: per-speaker voice + suggestion, and the total people count.
      val spkRows = JSONArray(db.rawQueryJson(
        "SELECT display_name, voice IS NOT NULL AS has_voice, suggested_person " +
          "FROM speakers WHERE meeting_id=? ORDER BY cluster_label",
        arrayOf(id),
      ))
      for (k in 0 until spkRows.length()) {
        val s = spkRows.getJSONObject(k)
      println("PROBE   speaker ${s.getString("display_name")} has_voice=${s.getInt("has_voice") == 1} " +
        "suggested_person=${s.opt("suggested_person")}")
      }
    }
    println("PROBE people count: ${db.peopleCount()}")
    if (threadTagToProbe != null) {
      println("PROBE thread($threadTagToProbe): ${db.threadJson(ctx, threadTagToProbe)}")
    } else {
      println("PROBE thread: no tag on any of the newest meetings to probe")
    }
  }
}
