package com.innocorelabs.verbale.pipeline

import android.content.Context
import android.util.Log
import com.innocorelabs.verbale.billing.LicenceStore
import com.innocorelabs.verbale.data.AudioDb
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Ask this meeting.
 *
 * Retrieve the meeting's eight closest passages for the question (AudioDb.searchHits — keyword
 * and meaning, fused), build the prompt in C++ (nativeAskPrompt, fenced), generate with the
 * resident writer, validate in C++ (nativeValidateAnswer: cite or it is nothing), keep the
 * exchange in `asks`. Every answer points at the transcript; a "nothing" answer points at the
 * three closest passages instead, so the person still gets the retrieval.
 *
 * The gate is the writer's gate plus one: the processing service must be idle, because the
 * 1.5 B model resident twice is an OOM on a 3 GB phone.
 */
object Asker {
  private const val TAG = "Ask"
  const val PASSAGES = 8
  const val MAX_TOKENS = 200

  enum class Refusal { NOT_PRO, NO_MODEL, NOT_CAPABLE, BUSY }

  /** FTS's match markers (U+0002/U+0003) never belong in a prompt. */
  private val MARKERS = Regex("[\u0002\u0003]")

  /**
   * One passage the model was handed.
   *
   * [anchored] is whether it has a moment in the recording a person can be taken to: something
   * said (an utterance), or an item the rules lifted from a line (its anchor is that line's).
   * A minutes passage, the summary and the title were never said at any moment — they are indexed
   * at 0 — so a citation to one is not a citation a person can follow, and it is dropped rather
   * than shown as "Minutes · 0:00" (F17).
   */
  data class Passage(
    val speaker: String, val startMs: Long, val text: String, val refId: String, val anchored: Boolean = true,
  )

  /** Where an item was said: the speaker of the transcript line it came from, and when. */
  data class ItemMoment(val speakerId: String?, val startMs: Long)

  data class Result(
    val refusal: Refusal?, val id: String?, val answer: String, val citesJson: String, val nothing: Boolean,
  )

  /** In this order: the paywall before a missing download, a missing download before a busy phone. */
  fun gate(entitled: Boolean, writer: Boolean, embed: Boolean, capable: Boolean, busy: Boolean): Refusal? = when {
    !entitled -> Refusal.NOT_PRO
    !writer || !embed -> Refusal.NO_MODEL
    !capable -> Refusal.NOT_CAPABLE
    busy -> Refusal.BUSY
    else -> null
  }

  /**
   * The top passages as the prompt wants them: who said it (the utterance's speaker's display
   * name; "Someone" for an unnamed or unknown voice), when, and the words.
   *
   * An item is said by whoever said the line it was lifted from and carries that line's moment
   * ([itemMoment] — null for a hand-typed row, which was never said anywhere). Only what nobody
   * said — a minutes passage, the summary, the title, a typed row — is "Minutes", and none of
   * those is [Passage.anchored].
   */
  fun passages(
    hits: List<Retriever.Hit>,
    speakerOf: (String) -> String?,
    names: Map<String, String?>,
    itemMoment: (String) -> ItemMoment? = { null },
  ): List<Passage> =
    hits.take(PASSAGES).map { h ->
      val text = h.text.replace(MARKERS, "")
      fun said(speakerId: String?) = speakerId?.let { names[it] }?.takeIf { it.isNotBlank() } ?: "Someone"
      when (h.kind) {
        "utterance" -> Passage(said(h.refId?.let(speakerOf)), h.startMs, text, h.refId ?: "")
        "item" -> {
          val m = h.refId?.let(itemMoment)
          if (m != null) Passage(said(m.speakerId), m.startMs, text, h.refId ?: "")
          else Passage("Minutes", h.startMs, text, h.refId ?: "", anchored = false)
        }
        else -> Passage("Minutes", h.startMs, text, h.refId ?: "", anchored = false)
      }
    }

  private val CITE = Regex(" ?\\[(\\d+)]")

  /**
   * The model's answer with every citation to a passage nobody can be taken to removed — before
   * validation, so the C++ validator's per-sentence rule does the rest: a sentence left with no
   * cite goes, and an answer left with none is the "nothing" state. A cite to a minutes passage is
   * dropped, never shown as a moment it does not have (F17).
   */
  fun withoutUnresolvableCites(raw: String, ps: List<Passage>): String =
    CITE.replace(raw) { m ->
      val n = m.groupValues[1].toIntOrNull()
      if (n != null && ps.getOrNull(n - 1)?.anchored == false) "" else m.value
    }

  private val META = Regex("\\b(the|these|those|this|given|provided) (passages?|excerpts?)\\b(?! of\\b)", RegexOption.IGNORE_CASE)

  /**
   * The answer is about the passages the model was shown, not about the meeting.
   *
   * Asked something the meeting never covers ("what is the CEO salary"), the 1.5B writer does not
   * always take the refusal the prompt offers: on a Galaxy A07 it wrote "The passage focuses on
   * financial matters ... but doesnot [1] [2] [3]". That is cited, so the validator keeps it, and
   * it is not an answer. The model has no reason to use these words in a real answer — the
   * passages are the prompt's word for the meeting's own sentences — so an answer that does is the
   * model failing to find one, and it is the "nothing" state like any other.
   */
  fun talksAboutThePassages(answer: String): Boolean = META.containsMatchIn(answer)

  /** The "nothing" state's pointers: the closest passages that HAVE a moment, up to three. */
  fun closestResolvable(ps: List<Passage>): List<Int> =
    ps.indices.filter { ps[it].anchored }.take(3).map { it + 1 }

  /** `[{n, refId, startMs, speaker}]` in the answer's order; a number the passages lack is dropped. */
  fun citesJson(cites: List<Int>, ps: List<Passage>): String {
    val out = JSONArray()
    for (n in cites) {
      val p = ps.getOrNull(n - 1) ?: continue
      out.put(JSONObject().put("n", n).put("refId", p.refId).put("startMs", p.startMs).put("speaker", p.speaker))
    }
    return out.toString()
  }

  fun ask(ctx: Context, meetingId: String, question: String, handle: () -> Long): Result {
    val q = question.trim()
    gate(
      entitled = LicenceStore.entitled(ctx),
      writer = Narrator.modelFile(ctx) != null,
      embed = EmbedRuntime.modelFile(ctx) != null,
      capable = Narrator.capable(ctx),
      busy = ProcessingService.isProcessing,
    )?.let { return Result(it, null, "", "[]", true) }

    val db = AudioDb.get(ctx)
    val hits = db.searchHits(ctx, q, meetingId)
    val names = db.speakers(meetingId).associate { it.id to it.displayName }
    val ps = passages(hits, speakerOf = { db.utteranceSpeaker(it) }, names = names, itemMoment = { db.itemMoment(it) })
    val nothing = NativeBridge.nativeAskNothing()
    if (ps.isEmpty()) return store(db, meetingId, q, nothing, "[]", nothingAnswer = true)

    val prompt = NativeBridge.nativeAskPrompt(
      q, ps.map { it.speaker }.toTypedArray(), ps.map { it.startMs }.toLongArray(), ps.map { it.text }.toTypedArray(),
    )
    val h = handle()
    if (h == 0L) return Result(Refusal.NO_MODEL, null, "", "[]", true)
    val t0 = System.currentTimeMillis()
    // Grammar-constrained, like the classifier: the writer was measured answering correctly and
    // citing nothing, and an answer that cites nothing is nothing. The grammar makes it choose.
    val raw = NativeBridge.nativeLlmGenerateConstrained(h, prompt, MAX_TOKENS, NativeBridge.nativeAskGrammar(ps.size)).trim()
    // A cite to a minutes/summary/title passage has no moment and is removed first; the validator
    // then drops any sentence left uncited and calls an answer left with nothing "nothing".
    val v = JSONObject(NativeBridge.nativeValidateAnswer(withoutUnresolvableCites(raw, ps), ps.size))
    val isNothing = v.getBoolean("nothing") || talksAboutThePassages(raw)
    val cites = if (isNothing) {
      closestResolvable(ps)   // the closest passages that have a moment, so the screen has somewhere to point
    } else {
      val arr = v.getJSONArray("cites")
      (0 until arr.length()).map { arr.getInt(it) }
    }
    Log.i(TAG, "answered in ${System.currentTimeMillis() - t0}ms: ${cites.size} cite(s), nothing=$isNothing")
    return store(db, meetingId, q, if (isNothing) nothing else v.getString("text"), citesJson(cites, ps), isNothing)
  }

  private fun store(db: AudioDb, meetingId: String, q: String, answer: String, citesJson: String, nothingAnswer: Boolean): Result {
    val id = UUID.randomUUID().toString()
    db.insertAsk(meetingId, id, q, answer, citesJson)
    return Result(null, id, answer, citesJson, nothingAnswer)
  }
}
