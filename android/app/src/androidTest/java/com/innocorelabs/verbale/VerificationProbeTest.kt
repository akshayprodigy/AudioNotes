package com.innocorelabs.verbale

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ModelCatalog
import com.innocorelabs.verbale.pipeline.DeviceFit
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
        "SELECT id, title, status, duration_ms, embedded_at, tier_used, template, template_source, mode " +
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
        "template=${m.opt("template")} template_source=${m.opt("template_source")} mode=${m.opt("mode")}")
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
      // Phase 5: which of the first lines a rule or a spoken mark rewrote (text_raw kept).
      val raw = JSONArray(db.rawQueryJson(
        "SELECT text_raw IS NOT NULL AS rewritten FROM utterances WHERE meeting_id=? ORDER BY start_ms LIMIT 6",
        arrayOf(id),
      ))
      println("PROBE   rewritten: " + (0 until raw.length()).joinToString(",") { raw.getJSONObject(it).getInt("rewritten").toString() })
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
    // Phase 4, the number behind a null suggestion: the cosine of every remembered person against
    // every speaker with a voice in the probed meetings. PeopleMatch suggests at MATCH_COSINE with
    // MATCH_MARGIN over the runner-up; a by-hand run that sees no "Sounds like" needs to know
    // whether it missed by a hair or by a mile. Voices come out as hex because rawQueryJson reads
    // blobs as strings.
    val people = JSONArray(db.rawQueryJson("SELECT name, hex(voice) AS v FROM people ORDER BY created_at", arrayOf()))
    if (people.length() > 0) {
      val spk = JSONArray(db.rawQueryJson(
        "SELECT s.display_name, hex(s.voice) AS v, substr(s.meeting_id, 1, 8) AS m " +
          "FROM speakers s JOIN meetings mt ON mt.id = s.meeting_id " +
          "WHERE s.voice IS NOT NULL ORDER BY mt.created_at DESC LIMIT 12",
        arrayOf(),
      ))
      fun vec(hex: String): FloatArray = com.innocorelabs.verbale.pipeline.VecCodec.decode(
        ByteArray(hex.length / 2) { i -> hex.substring(2 * i, 2 * i + 2).toInt(16).toByte() },
      )
      for (i in 0 until people.length()) {
        val pv = vec(people.getJSONObject(i).getString("v"))
        for (j in 0 until spk.length()) {
          val s = spk.getJSONObject(j)
          val sv = vec(s.getString("v"))
          var dot = 0f
          for (k in pv.indices) dot += pv[k] * sv[k]
          println("PROBE voice cos ${people.getJSONObject(i).getString("name")} vs ${s.getString("m")}/${s.getString("display_name")} = ${"%.3f".format(dot)} " +
            "(match at ${com.innocorelabs.verbale.pipeline.PeopleMatch.MATCH_COSINE})")
        }
      }
    }
    // Phase 5: the vocabulary, whole — it is small and it is the thing a by-hand run changes.
    val vocab = JSONArray(db.rawQueryJson("SELECT heard, meant, source, uses FROM vocabulary ORDER BY created_at", arrayOf()))
    println("PROBE vocabulary (${vocab.length()}): $vocab")
    // Device fit: what every screen is told about this phone before any download.
    val total = DeviceFit.totalBytes(ctx)
    println("PROBE device: total=$total marketed=${DeviceFit.marketedGb(total)} GB writerFits=${DeviceFit.writerFits(total)} " +
      "cpuFits=${DeviceFit.cpuFits()} free=${DeviceFit.freeBytes(ctx)} " +
      "reason=${DeviceFit.unsupportedReason(ctx, ModelCatalog.byId("llm-qwen")!!)}")
    if (threadTagToProbe != null) {
      println("PROBE thread($threadTagToProbe): ${db.threadJson(ctx, threadTagToProbe)}")
    } else {
      println("PROBE thread: no tag on any of the newest meetings to probe")
    }
  }
}
