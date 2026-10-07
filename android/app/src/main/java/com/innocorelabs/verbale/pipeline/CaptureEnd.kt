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

/**
 * The capture thread's closing sequence in one place, so its ORDER can be tested with fakes (N05):
 * flush the tail of the audio, close the file (which flushes again), and tear the service down —
 * in that order, each step contained, so that a full disk throwing from the flush OR the close
 * can never skip [stopSelf] and leave "Recording" over a dead worker.
 *
 * [stopSelf] runs when the end reason is anything but a normal Stop (a Stop tears the service down
 * itself, in its own route). Returns the end reason that stands. That the real service then stops
 * on a genuinely full disk is device-only.
 */
object CaptureLoopClose {
  fun run(endReason: String, flush: () -> Unit, close: () -> Unit, stopSelf: () -> Unit): String {
    var reason = CaptureEnd.afterFlush(endReason, flush)
    reason = try {
      close()
      reason
    } catch (e: Exception) {
      try { Log.e("RecordingService", "closing the audio file failed", e) } catch (_: Throwable) {}
      CaptureEnd.reasonAfterFailure(reason)
    }
    if (reason != RecordingService.END_NORMAL) stopSelf()
    return reason
  }
}
