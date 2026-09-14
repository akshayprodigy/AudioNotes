package com.innocorelabs.verbale.pipeline

/**
 * Keeps the spoken consent clip out of the recogniser's input.
 *
 * The clip is played into the live microphone on purpose — the recording is the proof the room
 * was told, and [AnnouncementVerifier] locates it in the capture to 10 ms. But whisper cannot
 * transcribe it, and worse, a window that opens with it decodes to the clip's words alone and
 * drops the speech that follows: on the Galaxy A07 the first eighteen seconds of a meeting came
 * back as "by Vernell. The recording stays on this stove." and nothing else, and the same
 * eighteen seconds cut out on their own decoded perfectly (see AnnouncementSpanTest). With the
 * announcement on by default, that was the opening of every meeting on every phone with the
 * volume up.
 *
 * So the VAD spans that overlap the clip are removed before chunking — dropped, trimmed, or split
 * around it, with a margin on each side for the verifier's 10 ms resolution and the room's echo.
 * The audio is untouched, `announced_at` is untouched; only what whisper is asked to read changes.
 * The clip never appears in the transcript, which is more honest than the mangled line it used
 * to produce there.
 */
object AnnouncementSpan {
  /** Room on either side of the located clip. The verifier's lag is exact to 10 ms; echo is not. */
  const val MARGIN_MS = 500L

  /** Below this a trimmed remainder is the edge of the margin, not a word. */
  private const val MIN_REMAINDER_MS = 250L

  /**
   * [spans] as start/end pairs in ms, with [clipStartMs, clipEndMs] cut out. A negative
   * [clipStartMs] means no announcement was located and the spans come back as they were.
   */
  fun exclude(spans: LongArray, clipStartMs: Long, clipEndMs: Long, marginMs: Long = MARGIN_MS): LongArray {
    if (clipStartMs < 0 || clipEndMs <= clipStartMs) return spans
    val cutStart = clipStartMs - marginMs
    val cutEnd = clipEndMs + marginMs
    val out = ArrayList<Long>(spans.size)
    var i = 0
    while (i + 1 < spans.size) {
      val s = spans[i]
      val e = spans[i + 1]
      i += 2
      if (e <= cutStart || s >= cutEnd) {
        // Clear of the clip on one side or the other.
        out.add(s); out.add(e)
        continue
      }
      // Whatever lies before the cut, and whatever lies after it; each only if it is long enough
      // to hold speech. A span entirely inside the cut contributes neither and is dropped.
      if (s < cutStart && cutStart - s >= MIN_REMAINDER_MS) { out.add(s); out.add(cutStart) }
      if (e > cutEnd && e - cutEnd >= MIN_REMAINDER_MS) { out.add(cutEnd); out.add(e) }
    }
    return out.toLongArray()
  }
}
