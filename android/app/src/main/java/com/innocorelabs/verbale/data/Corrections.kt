package com.innocorelabs.verbale.data

import kotlin.math.max
import kotlin.math.min

/**
 * The rules of a transcript correction, as pure functions (F15).
 *
 * A correction used to be a row in `edits` that only the transcript screen and the exports read, so
 * the action, the search hit and the embedding built from that line kept the recogniser's words.
 * It is now WRITTEN THROUGH into `utterances.text` — the same thing the Pro vocabulary path has
 * always done — with the recogniser's wording kept once in `text_raw`, and the derived pieces are
 * rebuilt from the corrected text. Everything that decides WHAT to write lives here so a JVM test
 * can pin it; `AudioDb` is the persistence and `Rederive` the orchestration.
 *
 * No Android, no database, no clock.
 */
object Corrections {

  /** An utterance's identity and time range, which is all re-applying a correction needs. */
  data class Span(val id: String, val startMs: Long, val endMs: Long)

  /** A correction as it stood before a re-transcription deleted the utterance it was keyed to. */
  data class Snapshot(val startMs: Long, val endMs: Long, val value: String)

  /** Which new utterance gets which corrected text, and how many corrections matched nothing. */
  data class Reapplied(val applied: List<Pair<String, String>>, val dropped: Int)

  /** Smallest share of the SHORTER of the two ranges that must be shared for a line to count as the same one. */
  const val MIN_OVERLAP_SHARE = 0.5

  /** Milliseconds two ranges share; 0 when they only touch or do not meet. */
  fun overlapMs(aStart: Long, aEnd: Long, bStart: Long, bEnd: Long): Long =
    max(0L, min(aEnd, bEnd) - max(aStart, bStart))

  /**
   * The new utterance a correction belongs to, or null when none is close enough.
   *
   * The greatest overlap wins, an earlier line on a tie, and the winner must share at least
   * [MIN_OVERLAP_SHARE] of the SHORTER range — so a line split in two or two lines merged into one
   * still find a home, while a line the new transcript simply no longer has does not attach itself
   * to a neighbour that touches it. A zero-length range has no overlap with anything and so never
   * matches; transcribed lines always have a duration.
   */
  fun bestMatch(s: Snapshot, spans: List<Span>): Span? {
    var best: Span? = null
    var bestOverlap = 0L
    for (sp in spans.sortedBy { it.startMs }) {
      val o = overlapMs(s.startMs, s.endMs, sp.startMs, sp.endMs)
      if (o <= bestOverlap) continue
      val shorter = max(1L, min(s.endMs - s.startMs, sp.endMs - sp.startMs))
      if (o.toDouble() / shorter < MIN_OVERLAP_SHARE) continue
      best = sp
      bestOverlap = o
    }
    return best
  }

  /**
   * Every snapshot placed on the new transcript.
   *
   * Two corrections can land on the same new line (merged utterances). One text has to win; the
   * correction that overlaps most does, the earlier on a tie, and the other is counted as dropped —
   * a person is told, once, rather than having one of two corrections silently vanish.
   */
  fun reapply(snapshots: List<Snapshot>, spans: List<Span>): Reapplied {
    data class Claim(val snap: Snapshot, val overlap: Long)
    val claims = HashMap<String, Claim>()
    var dropped = 0
    for (s in snapshots.sortedBy { it.startMs }) {
      val m = bestMatch(s, spans)
      if (m == null) {
        dropped++
        continue
      }
      val o = overlapMs(s.startMs, s.endMs, m.startMs, m.endMs)
      val held = claims[m.id]
      if (held == null) {
        claims[m.id] = Claim(s, o)
      } else if (o > held.overlap) {
        claims[m.id] = Claim(s, o)
        dropped++
      } else {
        dropped++
      }
    }
    // Deterministic order, the transcript's.
    val applied = spans.sortedBy { it.startMs }.mapNotNull { sp -> claims[sp.id]?.let { sp.id to it.snap.value } }
    return Reapplied(applied, dropped)
  }

  /**
   * What a line's two columns become when [value] is written through: the line says [value], and
   * `text_raw` keeps the wording before the FIRST correction — never overwritten once set. Returns
   * (text, text_raw).
   */
  fun writeThrough(text: String, raw: String?, value: String): Pair<String, String> =
    value to (raw ?: text)

  /**
   * What a line's two columns become when its correction is cleared. The line goes back to the
   * recogniser's wording with the vocabulary [restore]d over it, which is what the pipeline would
   * have left there; `text_raw` is cleared again only when nothing but the correction had
   * separated the two. A line that was never corrected keeps what it has.
   */
  fun revert(text: String, raw: String?, restore: (String) -> String = { it }): Pair<String, String?> {
    if (raw == null) return text to null
    val back = restore(raw)
    return if (back == raw) raw to null else back to raw
  }

  /** The narration was written from words that have since changed. Only a written summary can go stale. */
  fun narrationStale(hasWrittenSummary: Boolean, textChanged: Boolean): Boolean =
    hasWrittenSummary && textChanged

  /** Only a finished meeting is re-derived straight away; a run in flight reads the corrected lines itself. */
  fun rederiveNow(status: String?): Boolean =
    status != null && com.innocorelabs.verbale.pipeline.ResumePlan.finished(status)

  /** The one-time sentence for corrections a re-transcription could not place; null when there are none. */
  fun droppedNotice(count: Int): String? = when {
    count <= 0 -> null
    count == 1 -> "1 correction couldn't be re-applied"
    else -> "$count corrections couldn't be re-applied"
  }

  fun narrationStaleKey(meetingId: String) = "narration.stale.$meetingId"
  fun droppedKey(meetingId: String) = "corrections.dropped.$meetingId"
  fun rederivePendingKey(meetingId: String) = "rederive.pending.$meetingId"
}
