package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.data.AudioDb
import java.util.UUID
import kotlin.math.max
import kotlin.math.min

/**
 * Matching a reprocess's items to the ones already stored.
 *
 * Pure: no database, no Android, no clock. Everything it decides is decided from its two
 * arguments, which is what lets the whole matrix in ReconcilerTest run on the JVM. If a change
 * here ever wants `System.currentTimeMillis()` or a query, the boundary has moved to the wrong
 * place: `AudioDb.replaceItems` is persistence, this is policy, and mixing them makes the policy
 * untestable.
 *
 * The rule it enforces is the one the improvement report states and the old text-hash keying
 * broke: completion state and user edits survive a reprocess, and an ambiguous match is shown to
 * a person rather than resolved by guessing. A tick lost here is invisible — nobody notices the
 * item they ticked last week is unticked — so the failure mode is silence and the design answer
 * is to never drop a row a person has touched.
 *
 * What it decides, in order:
 *
 *  1. Rows a person typed ([AudioDb.StoredItem.genVersion] == "user") are set aside first. They
 *     are not produced by the rules, so nothing the rules emit can be "the same item"; they are
 *     carried through untouched and are never matched, replaced or flagged.
 *  2. Every legal (stored, incoming) pair is scored, and the pairs are taken best-first across the
 *     whole meeting. Matching each incoming item against the best remaining candidate in arrival
 *     order lets a poor early match steal the row a later, perfect match needed.
 *  3. A pair at or above [CONFIDENT_SIMILARITY] carries the stored row's review forward untouched.
 *     Below it, the row is still carried — the state is never thrown away — but marked
 *     `needs_review`, because the alternative is deciding on the person's behalf and not saying so.
 *  4. Whatever matched nothing is kept if a person has touched it in any way, and dropped only if
 *     nobody ever has.
 *
 * The caller supplies the two facts this cannot know: [Row.createdAt] and [Row.genVersion] are
 * null for content that came from this run, meaning "stamp it with now and with this run's
 * version". Non-null means the content is preserved from disk and so is its history.
 */
object Reconciler {

  /**
   * One row to write.
   *
   * [id] is the identity everything else hangs off — the tick in `item_done`, the review, and any
   * link a person has shared. Reusing it is the entire point of this class.
   *
   * [createdAt] is the stored row's original timestamp when this row continues one, and null when
   * the row is genuinely new. Null means "stamp now"; it does not mean "epoch".
   *
   * [genVersion] is null when [item] came from this run's extraction (stamp it with the run's
   * version) and non-null when the content was preserved from disk — a hand-written item, or an
   * item retained after it stopped being extracted. Writing the run's version over those would
   * relabel a person's own text as rules output, and on the next reprocess a user item relabelled
   * `rules@N` stops being protected by rule 1 above.
   */
  data class Row(
    val id: String,
    val item: Minutes.Item,
    val review: String,
    val createdAt: Long?,
    val genVersion: String?,
  )

  data class Plan(val rows: List<Row>)

  /**
   * Below this, two items that overlap in time are carried forward but not trusted.
   *
   * A guess, and worth knowing it is one. On token overlap (Jaccard), a ten-word action with one
   * word re-recognised scores 9/11 ≈ 0.82 and a five-word one scores 4/6 ≈ 0.67, so ordinary
   * re-recognition clears it; two different actions that share an opening verb and an article
   * score around 0.2-0.45 and do not. The consequence of being wrong is asymmetric and mild: too
   * high only adds a review flag to something that did not need one, and the state is carried
   * either way. Too low silently trusts a bad pair, which is why it is not lower.
   */
  private const val CONFIDENT_SIMILARITY = 0.6

  /** Anchors must overlap at all before text is even considered. */
  private const val MIN_OVERLAP_MS = 1L

  /** `gen_version` of an item a person typed. See rule 1. */
  private const val USER_GEN = "user"

  private const val SUGGESTED = "suggested"
  private const val NEEDS_REVIEW = "needs_review"
  private const val REJECTED = "rejected"

  /** A scored (incoming, stored) pair, sorted best-first in [reconcile]. */
  private data class Pairing(val incomingIndex: Int, val storedIndex: Int, val score: Double)

  fun reconcile(existing: List<AudioDb.StoredItem>, incoming: List<Minutes.Item>): Plan {
    // Rule 1: hand-written rows take no part in matching at all.
    val candidates = existing.filter { it.genVersion != USER_GEN }

    // Rule 2: score every legal pair, then take them best-first across the whole meeting rather
    // than incoming-item by incoming-item. Ties break on position so the result does not depend
    // on list order in any way.
    val pairings = ArrayList<Pairing>()
    for (i in incoming.indices) {
      val item = incoming[i]
      for (j in candidates.indices) {
        val old = candidates[j]
        if (old.kind != item.kind) continue
        val overlap = min(old.anchorEndMs, item.anchorEndMs) - max(old.anchorStartMs, item.anchorStartMs)
        if (overlap < MIN_OVERLAP_MS) continue
        val score = similarity(normalise(old.text), normalise(item.text))
        // Sharing not one word is not a weak match, it is a different sentence.
        if (score <= 0.0) continue
        pairings.add(Pairing(i, j, score))
      }
    }
    pairings.sortWith(
      compareByDescending<Pairing> { it.score }.thenBy { it.incomingIndex }.thenBy { it.storedIndex },
    )

    val matched = arrayOfNulls<AudioDb.StoredItem>(incoming.size)
    val matchedScore = DoubleArray(incoming.size)
    val storedTaken = BooleanArray(candidates.size)
    for (p in pairings) {
      if (matched[p.incomingIndex] != null || storedTaken[p.storedIndex]) continue
      matched[p.incomingIndex] = candidates[p.storedIndex]
      matchedScore[p.incomingIndex] = p.score
      storedTaken[p.storedIndex] = true
    }

    val rows = ArrayList<Row>(incoming.size + existing.size)
    val reusedIds = HashSet<String>(incoming.size)
    for (i in incoming.indices) {
      val old = matched[i]
      if (old == null) {
        rows.add(Row(UUID.randomUUID().toString(), incoming[i], SUGGESTED, null, null))
        continue
      }
      reusedIds.add(old.id)
      // Rule 3. Confident: carry everything forward untouched. Ambiguous: carry it forward AND
      // say so. The row's text is this run's, so its created_at is the only history it keeps.
      val review = if (matchedScore[i] >= CONFIDENT_SIMILARITY) old.review else NEEDS_REVIEW
      rows.add(Row(old.id, incoming[i], review, old.createdAt, null))
    }

    // Rule 4. Whatever is left matched nothing. Iterating `existing` rather than `candidates`
    // keeps the user rows, which were never candidates and must still be written back — the
    // caller deletes and re-inserts the meeting's items from this plan, so a row missing here is
    // a row deleted from the database.
    for (old in existing) {
      if (old.id in reusedIds) continue
      val preserved = Minutes.Item(
        old.kind,
        old.text,
        old.sources.map {
          Minutes.Source(it.utteranceId ?: "", it.startMs, it.endMs, it.charStart, it.charEnd)
        },
        old.anchorStartMs,
        old.anchorEndMs,
      )
      val review = when {
        // A person's own item. Untouched means untouched: not re-flagged, not re-stamped.
        old.genVersion == USER_GEN -> old.review
        // Already rejected, and now not even extracted. Both agree it does not belong. Asking
        // again every reprocess is how a review queue turns into noise; dropping it would let the
        // next recogniser improvement re-suggest it as brand new. Keeping the "no" is what makes
        // it stick.
        old.review == REJECTED -> REJECTED
        // Untouched by anyone and no longer extracted: genuinely gone. `review == suggested` is
        // not enough on its own to say that — a tick lives in item_done and never changes review,
        // so a finished item can still read `suggested`, and dropping it deletes the tick.
        old.review == SUGGESTED && !old.done -> continue
        // Confirmed, edited, or ticked, and the rules no longer find it. This row is now the only
        // record of it, so it is kept and flagged rather than deleted.
        else -> NEEDS_REVIEW
      }
      rows.add(Row(old.id, preserved, review, old.createdAt, old.genVersion))
    }
    return Plan(rows)
  }

  private fun normalise(s: String) = s.trim().lowercase().replace(Regex("\\s+"), " ")

  /**
   * Token overlap (Jaccard). Cheap, order-insensitive, and enough to tell a re-recognition of the
   * same sentence from a different sentence spoken at the same moment.
   *
   * Order-insensitive is a real limitation and an accepted one: "Priya sends Raj the file" and
   * "Raj sends Priya the file" score 1.0. Both are still carried forward with their state, so the
   * cost of the confusion is a missing review flag, not a lost tick.
   */
  private fun similarity(a: String, b: String): Double {
    if (a == b) return 1.0
    val ta = a.split(' ').filter { it.isNotEmpty() }.toSet()
    val tb = b.split(' ').filter { it.isNotEmpty() }.toSet()
    if (ta.isEmpty() || tb.isEmpty()) return 0.0
    val shared = ta.intersect(tb).size.toDouble()
    return shared / (ta.size + tb.size - shared)
  }
}
