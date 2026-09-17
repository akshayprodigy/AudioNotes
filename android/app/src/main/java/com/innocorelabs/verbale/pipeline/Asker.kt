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

  data class Passage(val speaker: String, val startMs: Long, val text: String, val refId: String)

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
   * name; "Someone" for an unnamed or unknown voice; "Minutes" for an item or the summary, which
   * nobody said), when, and the words.
   */
  fun passages(hits: List<Retriever.Hit>, speakerOf: (String) -> String?, names: Map<String, String?>): List<Passage> =
    hits.take(PASSAGES).map { h ->
      val speaker = when (h.kind) {
        "utterance" -> h.refId?.let(speakerOf)?.let { names[it] }?.takeIf { it.isNotBlank() } ?: "Someone"
        else -> "Minutes"
      }
      Passage(speaker, h.startMs, h.text.replace(MARKERS, ""), h.refId ?: "")
    }

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
    val ps = passages(hits, speakerOf = { db.utteranceSpeaker(it) }, names = names)
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
    val v = JSONObject(NativeBridge.nativeValidateAnswer(raw, ps.size))
    val isNothing = v.getBoolean("nothing")
    val cites = if (isNothing) {
      (1..minOf(3, ps.size)).toList()   // the closest passages, so the screen has somewhere to point
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
