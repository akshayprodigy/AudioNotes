package com.audionotes.pipeline

import org.json.JSONArray
import org.json.JSONObject

/** Mirrors src/pipeline/minutes.ts DraftMinute. kind in: summary|decision|action|question. */
data class DraftMinute(val kind: String, val content: String, val source: String = "rule")

/** The minimal utterance/speaker fields the extractor needs (subset of the DB rows). */
data class Utt(val text: String, val speakerId: String?)
data class Spk(val id: String, val displayName: String?)

/**
 * Rule-based minutes — now a thin marshaller over the shared C++ core (`NativeBridge.nativeMinutes`).
 *
 * This replaced `MinutesExtractor.kt`, a 230-line hand-maintained Kotlin port of the same rules.
 * Three copies of that logic existed (minutes.ts, minutes_extractor.cpp, MinutesExtractor.kt) and
 * only the first two were held together — by goldens generated from the real TS. The Kotlin copy
 * could drift silently, which is exactly what the shared-core architecture exists to prevent, so
 * it is gone and Kotlin now calls the same code the CLI does.
 *
 * Still rule-only, matching the old behaviour: LLM enhancement runs JS-side in
 * PipelineController.enhanceMinutes.
 */
object Minutes {
  /** Requires NativeBridge.ensureLoaded() to have run (ProcessingEngine does it first thing). */
  fun extract(utterances: List<Utt>, speakers: List<Spk> = emptyList()): List<DraftMinute> {
    val u = JSONArray()
    for (x in utterances) {
      u.put(JSONObject().put("text", x.text).put("speaker_id", x.speakerId ?: ""))
    }
    val s = JSONArray()
    for (x in speakers) {
      s.put(JSONObject().put("id", x.id).put("display_name", x.displayName ?: ""))
    }

    val arr = JSONArray(NativeBridge.nativeMinutes(u.toString(), s.toString()))
    val out = ArrayList<DraftMinute>(arr.length())
    for (i in 0 until arr.length()) {
      val o = arr.getJSONObject(i)
      out.add(DraftMinute(o.getString("kind"), o.getString("content"), o.optString("source", "rule")))
    }
    return out
  }
}
