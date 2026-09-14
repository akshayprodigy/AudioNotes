package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertArrayEquals
import org.junit.Test

/**
 * The spoken consent clip must never share a whisper window with the meeting.
 *
 * Measured on the Galaxy A07, 14 September, and reproduced on the host with the production model
 * and the same bytes: a window that opened with the 4.5-second synthesised clip, four seconds of
 * room, then eighteen seconds of clear speech decoded to ONE utterance — the clip's words,
 * mangled ("by Vernell. The recording stays on this stove.") — and nothing else. The same speech
 * cut out on its own decoded perfectly, decision and actions included. The clip alone decoded to
 * nothing. So whisper cannot transcribe the clip, and it drops whatever follows it in the window;
 * with the announcement on by default that is the first half-minute of every meeting on every
 * phone whose media volume is not zero.
 *
 * The verifier already knows exactly where the clip landed (its lag, to 10 ms). These tests pin
 * the one operation that keeps it out of the recogniser's input: the VAD spans that overlap the
 * clip are dropped or trimmed, with a margin on each side, and every other span is untouched.
 * The audio itself is not touched — the recording is still the evidence the room was told.
 */
class AnnouncementSpanTest {
  private val clipStart = 350L
  private val clipEnd = 350L + 4505L // the bundled clip's length, from its WAV header
  private val margin = 500L

  private fun exclude(vararg spans: Long): LongArray =
    AnnouncementSpan.exclude(spans, clipStart, clipEnd, margin)

  @Test
  fun `the span that is the clip is dropped and the speech after it is kept whole`() {
    // The A07 recording: VAD found the clip at ~0.3–5.0 s and the meeting at 9–27 s.
    assertArrayEquals(longArrayOf(9_000, 27_000), exclude(300, 5_000, 9_000, 27_000))
  }

  @Test
  fun `a span that runs from inside the clip into speech is trimmed to start after it`() {
    // Somebody talking over the tail of the clip: VAD joins them into one span. The clip's part is
    // cut, the person's part stays.
    assertArrayEquals(longArrayOf(clipEnd + margin, 12_000), exclude(2_000, 12_000))
  }

  @Test
  fun `a span that covers the whole clip is split around it`() {
    // A loud room with no gap at all: one VAD span from before the clip to after it. The clip is
    // placed at 3 s here so there is something in front of it to keep — at its usual 350 ms the
    // margin reaches back past zero and the front remainder is rightly nothing.
    val start = 3_000L
    val end = start + 4_505L
    assertArrayEquals(
      longArrayOf(0, start - margin, end + margin, 20_000),
      AnnouncementSpan.exclude(longArrayOf(0, 20_000), start, end, margin),
    )
  }

  @Test
  fun `a clip at the very start leaves nothing in front of it`() {
    // The ordinary case: the clip plays 350 ms into the capture. The margin reaches back past
    // zero, so the only remainder is the speech after it.
    assertArrayEquals(longArrayOf(clipEnd + margin, 20_000), exclude(0, 20_000))
  }

  @Test
  fun `spans well clear of the clip are returned untouched, in order`() {
    val spans = longArrayOf(9_000, 12_000, 15_000, 27_000, 43_000, 56_000)
    assertArrayEquals(spans, exclude(*spans))
  }

  @Test
  fun `a trimmed remainder too short to hold a word is dropped rather than sent to whisper`() {
    // 100 ms left over after the margin is not speech, it is the edge of the margin.
    assertArrayEquals(longArrayOf(), exclude(4_000, clipEnd + margin + 100))
  }

  @Test
  fun `no announcement means no change`() {
    val spans = longArrayOf(300, 5_000, 9_000, 27_000)
    assertArrayEquals(spans, AnnouncementSpan.exclude(spans, -1, -1, margin))
  }
}
