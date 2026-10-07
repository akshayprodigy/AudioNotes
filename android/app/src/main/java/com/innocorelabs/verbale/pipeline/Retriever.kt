package com.innocorelabs.verbale.pipeline

/**
 * One result list from the two ways of finding things.
 *
 * Reciprocal rank fusion (k = 60): each list votes 1/(k + rank) for a row, and a row in both
 * lists sums its votes. Scale-free, which is the whole point — bm25 and a cosine have nothing in
 * common but their order — and a row both ways found rises above one found either way alone.
 * Ties keep the keyword list's order. `byMeaning` survives only on a row the keyword list did
 * not have: that is the "≈" the screen shows, and it means "the words you typed are not here".
 */
object Retriever {
  const val K = 60
  const val TOP = 60

  /**
   * The least cosine a meaning hit may have to be shown on the search screen (F25). Measured, not
   * guessed: eval/measure_search_floor.py over the four AMI bench meetings (174 chunks + 40 minutes
   * items, 21 queries with answers and 13 with none), report
   * docs/superpowers/reports/2026-10-07-f25-search-floor.md. bge-small's cosines are compressed --
   * unrelated pairs sit at 0.40-0.57 (p95 0.571, max 0.767) and the best row for a query with NO
   * answer reached 0.54-0.63 -- so no floor separates the two cleanly. 0.60 is the highest floor
   * that still leaves 20 of 21 answerable queries with a relevant row (0.625 loses 4), and it cuts
   * the irrelevant rows shown per query from 36.6 to 5.2 and empties 8 of 13 no-answer queries.
   * AMI headset meetings, not phone recordings, and a small set: a starting value to re-check on
   * real meetings.
   */
  const val MEANING_MIN_SIMILARITY = 0.60

  /** No floor: every cosine is at least -1. Ask retrieval keeps this -- its floor is not measured. */
  const val NO_FLOOR = -1.0

  /**
   * `snippet` is for the screen (FTS's excerpt with its match markers, or a chunk's first 120
   * characters); `text` is the whole passage, for Ask — a model handed the snippet was handed
   * a fragment with control characters in it, and answered accordingly (measured 17 Sep).
   */
  data class Hit(
    val meetingId: String, val kind: String, val refId: String?, val startMs: Long, val endMs: Long,
    val snippet: String, val score: Double, val byMeaning: Boolean, val text: String = snippet,
  )

  /**
   * The meaning hits at or above [floor], in their order. A hit exactly at the floor stays. Must
   * run on the meaning list BEFORE [fuse]: after fusion `score` is a reciprocal-rank sum
   * (about 0.016), no longer a cosine, and a floor on it would drop everything.
   */
  fun aboveFloor(meaning: List<Hit>, floor: Double): List<Hit> = meaning.filter { it.score >= floor }

  /** The screen's list: keyword hits as they are, meaning hits that clear [floor], fused. */
  fun search(keyword: List<Hit>, meaning: List<Hit>, floor: Double): List<Hit> =
    fuse(keyword, aboveFloor(meaning, floor))

  fun fuse(keyword: List<Hit>, meaning: List<Hit>, k: Int = K, top: Int = TOP): List<Hit> {
    val score = LinkedHashMap<String, Double>()
    val row = HashMap<String, Hit>()
    fun key(h: Hit) = "${h.meetingId}/${h.kind}/${h.refId}"
    keyword.forEachIndexed { i, h ->
      val id = key(h)
      score[id] = (score[id] ?: 0.0) + 1.0 / (k + i + 1)
      row[id] = h.copy(byMeaning = false)
    }
    meaning.forEachIndexed { i, h ->
      val id = key(h)
      score[id] = (score[id] ?: 0.0) + 1.0 / (k + i + 1)
      if (id !in row) row[id] = h.copy(byMeaning = true)
    }
    // sortedByDescending is stable and `score` is insertion-ordered keyword-first, so a tie keeps
    // the keyword list's order.
    return score.entries.sortedByDescending { it.value }.take(top).map { row.getValue(it.key).copy(score = it.value) }
  }
}
