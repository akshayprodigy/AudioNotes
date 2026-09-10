package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.AudioDb.Review
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
 *  3. A pair at or above [CONFIDENT_SIMILARITY] carries the stored row's review forward untouched,
 *     unless the two texts disagree about negation ([negationChanged]), which is the one meaning
 *     change token overlap scores as near-identical. Below it, the row is still carried — the
 *     state is never thrown away — but marked `needs_review`, because the alternative is deciding
 *     on the person's behalf and not saying so.
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
   * **A guess, and worth knowing it is one.** What the number does is exact: for an n-token item
   * with one token substituted the Jaccard score is `(n-1)/(n+1)`, so 0.6 means one changed word
   * is confident from 4 tokens up, and two changed words from 8 tokens up. Real items carry a
   * " — Owner" suffix worth two tokens, so almost nothing falls under 4.
   *
   * Measured on the pairs below. These are INVENTED pairs, not real reprocesses — no before/after
   * item pairs from a phone exist yet, and Task 14 is where they come from. Anyone may re-run
   * this table; a number defended by a measurement you can re-run beats one that merely looks
   * principled.
   *
   * ```
   * SAME ITEM,  one word re-recognised (10 words)      0.846  confident
   * SAME ITEM,  one word re-recognised (5 words)       0.667  confident
   * SAME ITEM,  owner resolved by a speaker merge      0.667  confident
   * SAME ITEM,  filler dropped by better ASR           0.909  confident
   * SAME ITEM,  two words wrong in a 12-word action    0.750  confident
   * DIFFERENT,  same minute, shared verb + article     0.400  needs_review
   * DIFFERENT,  same minute, same owner                0.556  needs_review   <- closest miss
   * DIFFERENT,  same minute, both about "the report"   0.500  needs_review
   * DIFFERENT,  same minute, nothing shared            0.000  not matched
   * ```
   *
   * The margin between the worst same-item pair (0.667) and the best different-item pair (0.556)
   * is **0.11**. Thin. Dropping to 0.5 would make two different people's actions on the same
   * report a confident match, which is why it is not lower. The cost of being too high is mild
   * and one-sided — a review flag on something that did not need one — and the state is carried
   * forward either way.
   */
  private const val CONFIDENT_SIMILARITY = 0.6

  /**
   * Anchors must overlap at all before text is even considered.
   *
   * Deliberately a hard gate and not a tolerance window. An item whose anchor drifted entirely
   * past its old one under a re-ASR is unmatchable here at any similarity — but the consequence
   * is a SPLIT, not a loss: the incoming item gets a fresh row and the stored one is retained and
   * flagged by rule 4, so a person sees both. Real anchor drift under re-ASR has never been
   * measured, so widening this would be a second guess stacked on the guess above. Task 14 is
   * where the number should come from.
   */
  private const val MIN_OVERLAP_MS = 1L

  /**
   * Words that flip the sign of a sentence. Small and explicit on purpose — extend it here.
   *
   * Compared as MEANINGS, not as spellings: `cannot` and anything ending in `n't` canonicalise to
   * [NOT], so "will not" against "won't" and "cannot" against "can't" are the same negation and
   * not a change of sign. ASR flips between contracted and expanded forms between runs as a matter
   * of course, and a guard that called that a reversal would flag ordinary re-recognitions — a
   * queue that flags everything says nothing, which is the argument this guard is built on.
   *
   * The extractor folds U+2019 to an ASCII apostrophe before building an item's text, so the
   * contractions arrive spelled this way.
   */
  private const val NOT = "not"
  private val NEGATIONS = setOf(NOT, "never", "no")

  /** The negation this token expresses, or null if it is not one. See [NEGATIONS]. */
  private fun canonicalNegation(token: String): String? = when {
    token == "cannot" || token.endsWith("n't") -> NOT
    token in NEGATIONS -> token
    else -> null
  }

  /** `gen_version` of an item a person typed. See rule 1. */
  private const val USER_GEN = "user"

  // The review vocabulary lives in AudioDb.Review and is deliberately NOT re-declared here. These
  // states are compared as plain strings, and AudioDb.items() decides with the same four, so a
  // second copy would drift from the first without failing a build or raising anything.

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
    // Position breaks ties so the OUTPUT is reproducible, but reproducible is not the same as
    // order-independent: whichever item the extractor emitted first wins an exact tie, and a
    // different emission order would hand the row to the other one. That is precisely the
    // ambiguity this class says it never resolves by guessing, so a tied winner keeps the state
    // AND is flagged — see [tied].
    pairings.sortWith(
      compareByDescending<Pairing> { it.score }.thenBy { it.incomingIndex }.thenBy { it.storedIndex },
    )

    val matched = arrayOfNulls<AudioDb.StoredItem>(incoming.size)
    val matchedScore = DoubleArray(incoming.size)
    val tied = BooleanArray(incoming.size)
    val storedTaken = BooleanArray(candidates.size)
    for (p in pairings) {
      if (matched[p.incomingIndex] != null || storedTaken[p.storedIndex]) continue
      // Was anything else still in the running for the same row, or for the same incoming item,
      // at exactly this score? Then position alone chose the winner.
      tied[p.incomingIndex] = pairings.any { q ->
        q !== p && q.score == p.score &&
          (q.storedIndex == p.storedIndex || q.incomingIndex == p.incomingIndex) &&
          matched[q.incomingIndex] == null && !storedTaken[q.storedIndex]
      }
      matched[p.incomingIndex] = candidates[p.storedIndex]
      matchedScore[p.incomingIndex] = p.score
      storedTaken[p.storedIndex] = true
    }

    val rows = ArrayList<Row>(incoming.size + existing.size)
    val reusedIds = HashSet<String>(incoming.size)
    for (i in incoming.indices) {
      val old = matched[i]
      if (old == null) {
        rows.add(Row(UUID.randomUUID().toString(), incoming[i], Review.SUGGESTED, null, null))
        continue
      }
      reusedIds.add(old.id)
      // Rule 3. Confident: carry everything forward untouched. Ambiguous: carry it forward AND
      // say so. The row's text is this run's, so its created_at is the only history it keeps.
      //
      // Note what this does to a REJECTED row that matches ambiguously: `needs_review` overwrites
      // the rejection, so a person is asked again about something they already said no to. Rule 4
      // argues the opposite for a rejected row that vanished, and the difference is deliberate —
      // there the text was unchanged, here it changed enough that the machine cannot say it is the
      // same sentence, and re-asking about genuinely different text is a fair question. With a
      // margin of 0.11 around CONFIDENT_SIMILARITY this will happen, so it is stated rather than
      // left to be discovered.
      val confident = matchedScore[i] >= CONFIDENT_SIMILARITY &&
        !negationChanged(old.text, incoming[i].text) &&
        !tied[i]
      val review = if (confident) old.review else Review.NEEDS_REVIEW
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
          // utteranceId stays null when it was null. Writing "" back would turn "this row
          // never had one" into an empty string that reads like an id.
          Minutes.Source(it.utteranceId, it.startMs, it.endMs, it.charStart, it.charEnd)
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
        old.review == Review.REJECTED -> Review.REJECTED
        // Untouched by anyone and no longer extracted: genuinely gone. What counts as touched is
        // decided in AudioDb.items() and NOWHERE else — it spans four tables, three of which never
        // write to this row, and a fifth signal will arrive one day in a table this file has never
        // heard of and will not fail to compile here. Ask the one field; do not rebuild the
        // predicate. Note that `needs_review` is not engagement: this class writes that flag
        // itself, so counting it would make our own guess enough to keep a row forever.
        !old.touched -> continue
        // Confirmed, edited, or ticked, and the rules no longer find it. This row is now the only
        // record of it, so it is kept and flagged rather than deleted.
        else -> Review.NEEDS_REVIEW
      }
      rows.add(Row(old.id, preserved, review, old.createdAt, old.genVersion))
    }
    return Plan(rows)
  }

  private fun normalise(s: String) = s.trim().lowercase().replace(Regex("\\s+"), " ")

  /**
   * Did the evidence change sign between the two texts?
   *
   * "We will ship on Friday" and "We will not ship on Friday" share seven tokens of eight and
   * score 0.875 — comfortably confident, and opposite in meaning. Token overlap cannot see that,
   * so a decision that reversed between two runs would keep its confirmation with nothing said.
   * This does not understand the sentence; it only refuses to be confident when the negation
   * tokens differ, which is the same rule as everything else in this file: never guess silently.
   *
   * **Downgrade only.** It runs after a pair has already been chosen and can only turn a confident
   * match into `needs_review`. It never makes a non-match into a match, never drops a row, and
   * never reaches a user item — those are excluded from matching before any of this runs.
   *
   * What it does NOT close — misses AND false positives, because a list of only the former reads
   * as though there are none of the latter:
   *
   *  - MISS: a subject swap. "Priya sends Raj the file" and "Raj sends Priya the file" score 1.000
   *    with identical negation sets. Word order and who-does-what-to-whom are beyond any token
   *    guard and belong to Phase B's classifier.
   *  - MISS: sets, not counts, and not positions. "We will not ship but we will deploy" against
   *    "We will ship but we will not deploy" has `{not}` on both sides and stays confident. Same
   *    limit, same owner.
   *  - FALSE POSITIVE: `never` and `no` are not folded into [NOT], so "we will never ship" against
   *    "we will not ship" reads as a change of sign when both negate. Left unfolded because they
   *    are not spelling variants of one another the way `won't` and `will not` are — they differ
   *    in force — and because ASR does not interchange them the way it interchanges contractions.
   *    The cost when it does fire is one review flag on a carried-forward row, not lost state.
   */
  private fun negationChanged(a: String, b: String): Boolean =
    negations(normalise(a)) != negations(normalise(b))

  private fun negations(normalised: String): Set<String> =
    normalised.split(' ')
      .mapNotNull { canonicalNegation(it.trim { c -> !c.isLetter() && c != '\'' }) }
      .toSet()

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
