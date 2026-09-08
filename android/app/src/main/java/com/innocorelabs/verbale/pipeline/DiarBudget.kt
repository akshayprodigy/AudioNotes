package com.innocorelabs.verbale.pipeline

import android.app.ActivityManager
import android.content.Context

/**
 * Whether this phone can afford to work out who spoke, right now.
 *
 * Diarization is the one stage whose working set follows the LENGTH of the meeting rather than a
 * fixed model size, and meetings in this product are long: an hour to ninety minutes is ordinary,
 * because rooms full of people run over in a way calls do not. Measured on a 12 GB Pixel 7 Pro, a
 * 90-minute recording reached 2.55 GB and Android evicted nine background apps to pay for it.
 *
 * The answer is NOT to diarize such meetings in pieces. That was built, measured against AMI, and
 * shelved: cutting the audio into windows costs 6 DER points and 7 points of attribution, because
 * each window has to guess which of its speakers are the same people as the last window's. Speaker
 * labels that are confidently wrong are worse than slow ones. `cpp/diar/span_map.h` keeps the
 * machinery behind a flag that defaults to off.
 *
 * So this decides one thing: diarize the whole meeting, or skip it and say so. Skipping is a last
 * resort and should almost never happen — every phone that can afford the memory gets speaker
 * labels, however long the meeting ran.
 */
object DiarBudget {
  /**
   * Diarize the whole recording in one pass. Passed to the native side, which reads it as "no
   * windowing" — the shape every accuracy number this product quotes was measured in.
   */
  const val WHOLE_MEETING = -1L

  /** Not enough memory. Skip diarization, keep the meeting, tell the user why. */
  const val SKIP = 0L

  /** 16 kHz of float samples, which is what the diarizer reads. */
  private const val BYTES_PER_MS = 16000L * 4 / 1000

  /** Padding kept either side of each speech span. Must match kDiarPadMs in cpp/diar/span_map.h. */
  const val PAD_MS = 500L

  /**
   * What one byte of input costs in peak memory once sherpa has made its own copies.
   *
   * From the only measurement of it: 346 MB of input against 2.55 GB of peak PSS, which is 7.4x.
   * The app, the models and whisper all sit inside that 2.55 GB, so the diarization-only ratio is
   * lower and this over-estimates. Rounded up anyway — the cost of being wrong downwards is a
   * process the OS kills, and there is no recovering a meeting from that.
   */
  private const val PEAK_MULTIPLIER = 8L

  /**
   * The share of usable memory diarization may claim, as a fraction.
   *
   * `availableBytes` has already subtracted the level at which Android starts evicting background
   * processes, so what is left is genuinely spare. Most of it is claimable, and the quarter held
   * back covers the database, the UI if the user opens it, and the estimate above being wrong.
   *
   * Deliberately not half. Half would skip diarization on meetings the phone can plainly handle —
   * the 22.7-minute recording that ran cleanly at 0.64x realtime, and the 90-minute one on a
   * 12 GB phone — and a skipped meeting loses its speaker labels for nothing.
   */
  private const val CLAIM_NUMERATOR = 3L
  private const val CLAIM_DENOMINATOR = 4L

  /**
   * How to diarize a meeting with this much speech in it, given this much free memory.
   *
   * Returns [WHOLE_MEETING] or [SKIP]. There is deliberately nothing in between: the in-between
   * answer was windowing, and windowing is off.
   */
  @JvmStatic
  fun windowMsFor(availableBytes: Long, paddedSpeechMs: Long): Long {
    if (availableBytes <= 0 || paddedSpeechMs <= 0) return SKIP
    val budget = availableBytes / CLAIM_DENOMINATOR * CLAIM_NUMERATOR
    val needed = paddedSpeechMs * BYTES_PER_MS * PEAK_MULTIPLIER
    return if (needed <= budget) WHOLE_MEETING else SKIP
  }

  /**
   * An upper bound on how much audio diarization will actually read, from the VAD spans.
   *
   * The native side pads each span by [PAD_MS] either side and merges what then overlaps, so this
   * counts the padding for every span and ignores the merging — which can only make the real
   * figure smaller. Capped at the recording, because padding cannot invent audio.
   *
   * An upper bound rather than the exact number because the exact number lives in C++
   * (`padAndMerge`), and a second copy of that arithmetic in Kotlin would be a second place for
   * one rule to live. Over-estimating costs a little headroom; disagreeing would cost correctness.
   *
   * @param spansMs flat [startMs, endMs, ...], the array VAD returns.
   */
  @JvmStatic
  fun paddedSpeechUpperBoundMs(spansMs: LongArray, recordingMs: Long): Long {
    var total = 0L
    var i = 0
    while (i + 1 < spansMs.size) {
      val span = spansMs[i + 1] - spansMs[i]
      if (span > 0) total += span + 2 * PAD_MS
      i += 2
    }
    return if (recordingMs > 0) minOf(total, recordingMs) else total
  }

  /**
   * Memory this phone can give up without Android starting to kill things.
   *
   * `availMem` alone is the wrong number: `threshold` is the level at which the system begins
   * evicting background processes, so anything below it belongs to somebody else whether or not it
   * is currently occupied.
   */
  /** Free bytes as a round number, for the one log line that makes a field report diagnosable. */
  @JvmStatic
  fun describe(availableBytes: Long, paddedSpeechMs: Long): String =
    "${availableBytes / (1024 * 1024)} MB free, ${paddedSpeechMs / 60_000} min of speech"

  @JvmStatic
  fun availableBytes(ctx: Context): Long {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return 0
    val info = ActivityManager.MemoryInfo()
    am.getMemoryInfo(info)
    return (info.availMem - info.threshold).coerceAtLeast(0)
  }

  /**
   * What the meeting says when diarization was skipped for memory.
   *
   * Says what happened, what still works, and the one thing that will actually fix it. It does
   * NOT tell the user to label speakers by hand: the Speakers screen renames and merges speakers
   * that already exist and shows "No speakers yet" when there are none, so that instruction would
   * send them to a screen with nothing on it. An app that tells you to do something it cannot do
   * is worse than one that says nothing.
   *
   * Redo is real: ResumePlan adds Stage.DIARIZE back for any meeting with no speakers, so a
   * reprocess on a phone with memory free does add them.
   *
   * Stored on the meeting rather than composed in the UI, because the reason has to outlive the
   * run that made the decision — asking again tomorrow would read the memory the phone has then.
   */
  const val SKIPPED_FOR_MEMORY =
    "Speakers were not separated: this recording needed more memory than the phone had free. " +
      "The transcript, the minutes and the summary are all complete. Redo will add speakers when " +
      "the phone has more memory available."
}
