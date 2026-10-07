package com.innocorelabs.verbale.pipeline

import org.json.JSONArray

/**
 * Stretches of a recording where the phone's microphone was silenced (a call, the privacy toggle,
 * another app taking the mic) — F26.
 *
 * While the system silences our capture, `AudioRecord` keeps returning buffers of pure silence, so
 * the file keeps its full length and the stretch transcribes to nothing, with nothing saying why.
 * [RecordingService] notes when the silencing starts and stops ([GapTracker], on the captured-audio
 * clock: milliseconds of audio written, pauses excluded — the same clock as the free limit) and
 * stores the result as `[[startMs,endMs],…]` under the settings key [key], once, at the end.
 *
 * The rules here are pure so they can be held without a phone:
 *  - overlapping or touching intervals merge;
 *  - an interval shorter than [MIN_MS] is dropped (a callback flicker is not a call);
 *  - every interval is clamped to the recording's length (and one that falls outside it is dropped);
 *  - [sentence] is the one line a person reads. The TypeScript twin is `src/capture/gaps.ts`;
 *    both pin the same examples.
 *
 * Android 10+ only (`isClientSilenced`); older phones record no gaps. Whether a real call produces
 * the callback, and when, is device-only.
 */
object GapPolicy {
  /** Shorter than this is not worth a sentence. */
  const val MIN_MS = 2_000L

  fun key(meetingId: String) = "capture_gaps:$meetingId"

  /** Merged, clamped to [0, [recordingMs]] and without anything shorter than [MIN_MS], sorted by start. */
  fun normalise(intervals: List<LongArray>, recordingMs: Long): List<LongArray> {
    val clamped = intervals.mapNotNull { iv ->
      if (iv.size < 2) return@mapNotNull null
      val s = maxOf(0L, minOf(iv[0], iv[1]))
      val e = minOf(maxOf(iv[0], iv[1]), recordingMs)
      if (e > s) longArrayOf(s, e) else null
    }.sortedBy { it[0] }
    val merged = ArrayList<LongArray>()
    for (iv in clamped) {
      val last = merged.lastOrNull()
      if (last != null && iv[0] <= last[1]) last[1] = maxOf(last[1], iv[1]) else merged.add(longArrayOf(iv[0], iv[1]))
    }
    return merged.filter { it[1] - it[0] >= MIN_MS }
  }

  /** Total silenced milliseconds of the normalised intervals. */
  fun totalMs(intervals: List<LongArray>, recordingMs: Long): Long =
    normalise(intervals, recordingMs).sumOf { it[1] - it[0] }

  fun toJson(intervals: List<LongArray>): String {
    val out = JSONArray()
    for (iv in intervals) out.put(JSONArray().put(iv[0]).put(iv[1]))
    return out.toString()
  }

  /**
   * What to write at the end of a capture: the intervals noted this run, joined with any a run
   * killed earlier left stored (a restarted service starts a fresh tracker), normalised against the
   * final length. Null when there is nothing to store, so a recording with no interruption writes
   * no setting at all.
   */
  fun toStore(existingRaw: String?, noted: List<LongArray>, recordingMs: Long): String? {
    val all = normalise(fromJson(existingRaw) + noted, recordingMs)
    return if (all.isEmpty()) null else toJson(all)
  }

  /** Malformed or missing text is no intervals, never an exception. */
  fun fromJson(raw: String?): List<LongArray> {
    if (raw.isNullOrBlank()) return emptyList()
    return try {
      val arr = JSONArray(raw)
      (0 until arr.length()).mapNotNull { i ->
        val pair = arr.optJSONArray(i) ?: return@mapNotNull null
        if (pair.length() < 2) null else longArrayOf(pair.optLong(0), pair.optLong(1))
      }
    } catch (_: Exception) {
      emptyList()
    }
  }

  /**
   * The sentence for [silencedMs] in total, or null under a second. (The floor that keeps a
   * flicker out is [normalise]'s, applied before the total reaches here.) Under a minute it counts
   * seconds ("1 second", "45 seconds"); from a minute it rounds to whole minutes.
   */
  fun sentence(silencedMs: Long): String? {
    if (silencedMs < 1_000L) return null
    val seconds = silencedMs / 1000L
    val amount = if (seconds < 60L) {
      if (seconds == 1L) "1 second" else "$seconds seconds"
    } else {
      "${(seconds + 30L) / 60L} min"
    }
    return "Your phone's microphone was silenced for $amount (a call, or another app) — that part wasn't recorded."
  }
}

/**
 * Notes silenced intervals as they happen, on the captured-audio clock the caller supplies.
 * Called from the audio-callback thread and read from the service thread, hence synchronized.
 * An interval still open when the recording ends is closed at the end by [finish].
 */
class GapTracker {
  private val closed = ArrayList<LongArray>()
  private var openedAt: Long = -1L

  @Synchronized fun onSilenced(silenced: Boolean, atMs: Long) {
    if (silenced) {
      if (openedAt < 0L) openedAt = atMs
    } else if (openedAt >= 0L) {
      closed.add(longArrayOf(openedAt, atMs))
      openedAt = -1L
    }
  }

  /** Everything noted so far, with an open interval closed at [endMs]. */
  @Synchronized fun finish(endMs: Long): List<LongArray> {
    val out = ArrayList<LongArray>(closed.map { it.copyOf() })
    if (openedAt >= 0L) out.add(longArrayOf(openedAt, endMs))
    return out
  }
}
