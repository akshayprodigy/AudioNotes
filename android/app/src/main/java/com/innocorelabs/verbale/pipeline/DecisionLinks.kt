package com.innocorelabs.verbale.pipeline

/**
 * "Changes: …" — the one clever part of thread memory (Phase 3). A pure rule over the vectors the
 * meaning index already computes (Embedder.fill), never the language model: for each decision, in
 * meetingAt order, find the closest EARLIER decision that is either near-identical in meaning or
 * near-identical in meaning-and-wording, and call that "the same decision, changed". See the brief
 * (`docs/superpowers/specs/2026-09-17-phase-3-thread-memory-brief.md`) §4 for the constants and the
 * eight measured pairs that chose them.
 */
object DecisionLinks {
  /** A cosine at or above this alone is close enough to be "the same decision, changed". */
  const val LINK_COSINE = 0.72f

  /** A weaker cosine still counts when the two decisions also share a content word. */
  const val LINK_COSINE_WITH_WORD = 0.60f

  /** A word shorter than this is noise ("a", "to", "of") and never counts as shared. */
  const val MIN_WORD_LETTERS = 4

  /** Words are compared on their first this-many letters, so "ship"/"shipping" and "vendor"/"vendors" match. */
  const val STEM_LETTERS = 5

  /** Common enough to turn up in almost any pair of sentences about a meeting; never "content". */
  val STOP_WORDS = setOf(
    "will", "that", "this", "with", "from", "have", "been", "were", "they", "them", "then", "than",
    "what", "when", "which", "there", "their", "about", "would", "could", "should", "next", "week",
    "today", "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
    "sunday", "decided", "agreed", "agree", "decide",
  )

  /**
   * One decision item, as the linker needs it. [vec] is the decoded (VecCodec.decode) vector from
   * `search_vec` for this item, or null when the meaning index has not reached it yet (free tier,
   * model absent, the embedding backfill has not caught up) — such a decision gets no link and
   * blocks no other decision from linking past it.
   */
  data class Decision(
    val itemId: String,
    val meetingId: String,
    val meetingAt: Long,
    val text: String,
    val vec: FloatArray?,
  )

  /**
   * Whether [a] and [b] share a real content word: lower-cased, split on non-letters, at least
   * [MIN_WORD_LETTERS] long, not a [STOP_WORDS] entry, compared on the shorter of their two
   * [STEM_LETTERS]-capped prefixes — which is what makes "ship" (four letters) match "shipping"
   * without also matching "shape".
   */
  fun sharedContentWord(a: String, b: String): Boolean {
    fun words(s: String): List<String> =
      s.lowercase().split(Regex("[^a-z]+")).filter { it.length >= MIN_WORD_LETTERS && it !in STOP_WORDS }

    fun sameStem(x: String, y: String): Boolean {
      val sx = x.take(STEM_LETTERS)
      val sy = y.take(STEM_LETTERS)
      val n = minOf(sx.length, sy.length)
      return sx.take(n) == sy.take(n)
    }

    val wa = words(a)
    if (wa.isEmpty()) return false
    val wb = words(b)
    return wa.any { x -> wb.any { y -> sameStem(x, y) } }
  }

  private fun cosine(a: FloatArray, b: FloatArray): Float {
    var s = 0f
    val n = minOf(a.size, b.size)
    for (i in 0 until n) s += a[i] * b[i]
    return s
  }

  /**
   * The later itemId → the earlier itemId it "changes", for every decision that has one.
   *
   * [cosineOf] is a seam for the test, which injects a lookup matrix rather than engineering real
   * vectors to a target cosine; production (AudioDb.threadJson) calls the single-argument overload,
   * which scores real decoded vectors.
   */
  fun link(decisions: List<Decision>, cosineOf: (Decision, Decision) -> Float): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    for (d in decisions) {
      if (d.vec == null) continue
      var bestId: String? = null
      var bestScore = Float.NEGATIVE_INFINITY
      for (e in decisions) {
        if (e.vec == null) continue
        if (e.meetingAt >= d.meetingAt) continue // strictly earlier MEETING; same meeting shares meetingAt
        val c = cosineOf(d, e)
        val qualifies = c >= LINK_COSINE || (c >= LINK_COSINE_WITH_WORD && sharedContentWord(d.text, e.text))
        if (qualifies && c > bestScore) {
          bestScore = c
          bestId = e.itemId
        }
      }
      if (bestId != null) out[d.itemId] = bestId
    }
    return out
  }

  /** Real vectors, both already unit length (Embedder.fill / VecCodec.decode) — dot is the cosine. */
  fun link(decisions: List<Decision>): Map<String, String> =
    link(decisions) { a, b -> cosine(a.vec!!, b.vec!!) }
}
