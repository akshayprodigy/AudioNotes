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

  data class Hit(
    val meetingId: String, val kind: String, val refId: String?, val startMs: Long, val endMs: Long,
    val snippet: String, val score: Double, val byMeaning: Boolean,
  )

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
