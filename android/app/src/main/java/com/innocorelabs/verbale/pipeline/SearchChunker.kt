package com.innocorelabs.verbale.pipeline

/**
 * The unit of meaning search: consecutive turns merged into windows of up to a hundred words,
 * never across a silence longer than thirty seconds, a single long turn standing alone.
 *
 * A hundred words is about forty seconds of speech — one point, made — which is the grain a
 * question lands on. A whole meeting in one vector matches every question a little and none
 * well; a single short turn ("yes, fine") carries no meaning of its own to match.
 *
 * The embedded text is the words only — no names, no stamps — so a speaker rename never
 * invalidates a vector, and `hash` (FNV-1a of the words) is what says whether one must be
 * recomputed. The speaker of the first line rides along for display, outside the vector.
 */
object SearchChunker {
  const val MAX_WORDS = 100
  const val MAX_GAP_MS = 30_000L

  data class Chunk(val refId: String, val startMs: Long, val endMs: Long, val speakerId: String?, val text: String)

  fun chunks(utts: List<Utt>): List<Chunk> {
    val out = ArrayList<Chunk>()
    var refId: String? = null
    var start = 0L
    var end = 0L
    var spk: String? = null
    var words = 0
    val sb = StringBuilder()
    fun flush() {
      val id = refId
      if (id != null && sb.isNotEmpty()) out.add(Chunk(id, start, end, spk, sb.toString()))
      refId = null
      sb.setLength(0)
      words = 0
    }
    for (u in utts) {
      val text = u.text.trim()
      if (text.isEmpty()) continue
      val n = text.split(WS).size
      val gap = refId != null && u.startMs - end > MAX_GAP_MS
      if (refId != null && (gap || words + n > MAX_WORDS)) flush()
      if (refId == null) {
        refId = u.id
        start = u.startMs
        spk = u.speakerId
      }
      if (sb.isNotEmpty()) sb.append(' ')
      sb.append(text)
      words += n
      end = u.endMs
    }
    flush()
    return out
  }

  /** FNV-1a over UTF-8, as the signed 64-bit SQLite stores. */
  fun hash(text: String): Long {
    var h = -0x340d631b7bdddcdbL  // 0xcbf29ce484222325, the offset basis
    for (b in text.toByteArray(Charsets.UTF_8)) {
      h = h xor (b.toLong() and 0xff)
      h *= 0x100000001b3L
    }
    return h
  }

  private val WS = Regex("\\s+")
}
