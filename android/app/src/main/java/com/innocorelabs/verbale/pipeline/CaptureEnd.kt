package com.innocorelabs.verbale.pipeline

import android.util.Log

/**
 * The end-of-capture steps of [RecordingService] that can be exercised off a phone.
 */
object CaptureEnd {
  /**
   * Run the capture loop's closing flush and say which end reason stands afterwards.
   *
   * The flush writes the last buffered audio to disk, so on a full disk it throws. Called from the
   * loop's `finally`, an exception there skipped `stopSelf()` and the end-reason bookkeeping after
   * it: the service kept showing "Recording" with a dead worker (N05). Here it is contained, and an
   * otherwise normal end is recorded as a write failure — the tail of the audio did not reach disk
   * — so the person is told and the meeting is still processed. A reason the loop already chose
   * (disk full, mic lost, the cap) is kept: that is the sentence the person should read.
   */
  fun afterFlush(endReason: String, flush: () -> Unit): String =
    try {
      flush()
      endReason
    } catch (e: Exception) {
      try { Log.e("RecordingService", "closing flush failed", e) } catch (_: Throwable) {}
      reasonAfterFailure(endReason)
    }

  /** The end reason once the audio file failed to write or close: write_failed, unless one is already set. */
  fun reasonAfterFailure(endReason: String): String =
    if (endReason == RecordingService.END_NORMAL) RecordingService.END_WRITE_FAILED else endReason
}
