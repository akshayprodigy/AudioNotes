package com.audionotes.pipeline

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
    val flat = NativeBridge.nativeMinutes(
      Array(utterances.size) { utterances[it].text },
      Array(utterances.size) { utterances[it].speakerId ?: "" },
      Array(speakers.size) { speakers[it].id },
      Array(speakers.size) { speakers[it].displayName ?: "" },
    )

    // Flat [kind, content, source] triples.
    val out = ArrayList<DraftMinute>(flat.size / 3)
    var i = 0
    while (i + 2 < flat.size) {
      out.add(DraftMinute(flat[i], flat[i + 1], flat[i + 2]))
      i += 3
    }
    return out
  }
}
