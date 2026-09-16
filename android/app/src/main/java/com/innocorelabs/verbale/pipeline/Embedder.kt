package com.innocorelabs.verbale.pipeline

import android.content.Context
import android.util.Log
import com.innocorelabs.verbale.data.AudioDb

/**
 * Keeps one meeting's vectors equal to its current words.
 *
 * Chunks the transcript (SearchChunker), adds the items and the summary, embeds only what is new
 * by hash, deletes what is gone, then stamps `embedded_at`. Idempotent and resumable: killed
 * halfway, the next call finishes the rest, because every batch is committed as it lands and the
 * stamp is the last thing written. Without a subscription or the model it returns false and
 * writes nothing — the sweep that called it stops asking.
 *
 * Runs in two places: the EMBED stage of ProcessingEngine, right after narration, and the JS
 * sweep's backfill for the library that was recorded before the index existed.
 */
object Embedder {
  private const val TAG = "Embed"
  /** Texts per JNI call — a thermal pause lands between batches, like any other unit of work. */
  const val BATCH = 16

  data class Want(
    val kind: String, val refId: String, val startMs: Long, val endMs: Long, val speakerId: String?, val text: String,
  ) {
    val hash: Long get() = SearchChunker.hash(text)
    /** A row's identity: these words, at this moment. Two windows saying "yes" are two rows. */
    val key: AudioDb.VecKey get() = AudioDb.VecKey(hash, refId)
  }

  data class Plan(val toEmbed: List<Want>, val toDelete: Set<AudioDb.VecKey>)

  /** Pure: what to embed and what to drop, given what the meeting wants and what the table has. */
  fun plan(wanted: List<Want>, have: Set<AudioDb.VecKey>): Plan {
    val wantKeys = wanted.map { it.key }.toSet()
    return Plan(wanted.filter { it.key !in have }, have.filter { it !in wantKeys }.toSet())
  }

  fun wanted(db: AudioDb, meetingId: String): List<Want> {
    val out = ArrayList<Want>()
    for (c in SearchChunker.chunks(db.utterances(meetingId))) {
      out.add(Want("turn", c.refId, c.startMs, c.endMs, c.speakerId, c.text))
    }
    for (i in db.itemsForIndex(meetingId)) out.add(Want("item", i.id, i.startMs, i.startMs, null, i.text))
    db.summaryText(meetingId)?.let { out.add(Want("summary", meetingId, 0, 0, null, it)) }
    return out
  }

  /**
   * @param onProgress done/total over the chunks this call embeds.
   * @param pause called before each batch — the processing service's thermal clearance; the
   *   backfill passes nothing.
   * @return true when the meeting is now fully embedded.
   */
  fun fill(
    ctx: Context,
    meetingId: String,
    onProgress: (Int, Int) -> Unit = { _, _ -> },
    pause: () -> Unit = {},
  ): Boolean {
    if (!EmbedRuntime.available(ctx)) return false
    val db = AudioDb.get(ctx)
    val p = plan(wanted(db, meetingId), db.vecKeys(meetingId))
    db.deleteVecs(meetingId, p.toDelete)
    val total = p.toEmbed.size
    var done = 0
    // Same words, one vector: two windows that both say "yes" are embedded once and written
    // twice. `seen` is what stops the second row being a second JNI call.
    val seen = HashMap<Long, FloatArray>()
    for (batch in p.toEmbed.chunked(BATCH)) {
      pause()
      val fresh = batch.filter { it.hash !in seen }.distinctBy { it.hash }
      if (fresh.isNotEmpty()) {
        val vecs = EmbedRuntime.embed(ctx, fresh.map { it.text }) ?: return false
        fresh.zip(vecs).forEach { (w, v) -> if (v.any { it != 0f }) seen[w.hash] = v }
      }
      val rows = batch.mapNotNull { w ->
        seen[w.hash]?.let { v ->
          AudioDb.VecRow(w.kind, w.refId, w.startMs, w.endMs, w.speakerId, w.text, w.hash, VecCodec.encode(v), EmbedRuntime.MODEL_ID)
        }
      }
      db.insertVecs(meetingId, rows)
      done += batch.size
      onProgress(done, total)
    }
    db.stampEmbedded(meetingId)
    Log.i(TAG, "embedded $total chunk(s) for $meetingId (${p.toDelete.size} dropped)")
    return true
  }
}
