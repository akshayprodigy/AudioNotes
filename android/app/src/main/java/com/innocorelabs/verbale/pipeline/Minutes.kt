package com.innocorelabs.verbale.pipeline

import org.json.JSONArray

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

  /**
   * One piece of evidence for an item: the turn it was said in, that turn's place in the meeting,
   * and where the sentence sits inside the turn's text.
   *
   * [charStart]/[charEnd] are UTF-16 code units — the unit a Kotlin string is indexed in — so
   * `turnText.substring(charStart, charEnd)` is the range to highlight. They cross the JNI boundary
   * unconverted for that reason; converting them would only misbehave on a transcript containing an
   * astral character, which is the kind of bug that ships.
   *
   * Do NOT rebuild [Item.text] from that substring. The offsets index the turn as it was recorded,
   * and the item text comes from a normalized copy — U+2019 folded to an ASCII apostrophe, and
   * whitespace runs collapsed to one space. Whisper emits curly apostrophes constantly, so the two
   * differ on most real meetings. The text is carried in the payload precisely so nothing has to
   * re-derive it. See the note on ItemSource in cpp/minutes/evidence.h.
   *
   * [utteranceId] is a convenience, not an identity: AudioDb re-mints utterance ids on every
   * recognition pass, so an id saved today points at nothing after a re-run. The anchor
   * ([startMs], [endMs]) is what survives.
   */
  data class Source(
    val utteranceId: String,
    val startMs: Long,
    val endMs: Long,
    val charStart: Int,
    val charEnd: Int,
  )

  /**
   * A rule-extracted decision, action or question, with every place it was said.
   *
   * [anchorStartMs]/[anchorEndMs] envelope ALL of [sources] — an item said at 1000-3000 and again
   * at 8000-9500 anchors at 1000-9500. That is an ordering key and a range to draw, never a range
   * to play; play a single source.
   */
  data class Item(
    val kind: String,  // decision | action | question
    val text: String,
    val sources: List<Source>,
    val anchorStartMs: Long,
    val anchorEndMs: Long,
  )

  /**
   * The same rules as [extract], plus the provenance it discards.
   *
   * The arrays are parallel and in transcript order: `ids[i]`, `startsMs[i]`, `endsMs[i]`,
   * `texts[i]` and `speakerIds[i]` describe one turn. `speakerIds[i]` is "" for an unassigned turn
   * — Kotlin cannot put a null in an Array<String>, and the C++ treats an empty id exactly as the
   * TypeScript treats null.
   *
   * Requires NativeBridge.ensureLoaded() to have run.
   */
  fun extractItems(
    ids: Array<String>,
    startsMs: LongArray,
    endsMs: LongArray,
    texts: Array<String>,
    speakerIds: Array<String>,
    spkIds: Array<String>,
    spkNames: Array<String>,
  ): List<Item> {
    // Checked HERE as well as in zipTurns on the far side, because this one runs before the native
    // call and is therefore testable without a device. A mismatch is a programming error: the
    // caller builds all five from one list. It is worth failing loudly because the quiet version is
    // nasty — surplus turns would anchor at 0, and an item said forty minutes in would send the
    // player to the top of the meeting with nothing reporting a problem.
    require(
      ids.size == texts.size && startsMs.size == texts.size && endsMs.size == texts.size &&
        speakerIds.size == texts.size,
    ) {
      "extractItems: parallel arrays disagree — ids=${ids.size} startsMs=${startsMs.size} " +
        "endsMs=${endsMs.size} speakerIds=${speakerIds.size} texts=${texts.size}"
    }
    return parseItems(
      NativeBridge.nativeItems(ids, startsMs, endsMs, texts, speakerIds, spkIds, spkNames),
    )
  }

  /**
   * The parse, split out of [extractItems] so it can be tested on the JVM with a literal string and
   * no device — see ItemsJsonTest, which drives it with the exact bytes
   * `audionotes::itemsToJson` emits for the goldens. What is left needing a phone is then the JNI
   * marshalling alone, which is where this project has broken silently before.
   *
   * What this actually guarantees, which is narrower than "strict": a MISSING field throws, so a
   * truncated or renamed payload cannot become a quietly empty item list that looks exactly like a
   * meeting with nothing in it. A MISTYPED field does NOT throw. Android's org.json is
   * Harmony-derived and coerces — `"kind": 42` arrives as "42", a JSON null as the four characters
   * "null" — where the reference implementation would reject both.
   *
   * Neither is reachable from `itemsToJson`, which writes a string for every string field, so this
   * is a property of the parser rather than a hole. It is written down because the two
   * implementations differ and the unit tests run against Android's; see
   * androidsParserCoercesWhereTheReferenceImplementationThrows in ItemsJsonTest.
   */
  internal fun parseItems(json: String): List<Item> {
    val arr = JSONArray(json)
    val out = ArrayList<Item>(arr.length())
    for (i in 0 until arr.length()) {
      val o = arr.getJSONObject(i)
      val sa = o.getJSONArray("sources")
      val sources = ArrayList<Source>(sa.length())
      for (j in 0 until sa.length()) {
        val s = sa.getJSONObject(j)
        sources.add(
          Source(
            s.getString("utteranceId"),
            s.getLong("startMs"),
            s.getLong("endMs"),
            s.getInt("charStart"),
            s.getInt("charEnd"),
          ),
        )
      }
      out.add(
        Item(
          o.getString("kind"),
          o.getString("text"),
          sources,
          o.getLong("anchorStartMs"),
          o.getLong("anchorEndMs"),
        ),
      )
    }
    return out
  }
}
