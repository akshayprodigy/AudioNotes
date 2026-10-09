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
      reasonAfterFailure(endReason, e)
    }

  /**
   * The end reason once the audio file failed to write or close: write_failed, unless one is already
   * set — or unless the cause was a full disk, which is what the person should be told. The free-space
   * check runs every half minute, so a phone that fills faster than that reaches this path first:
   * on a Galaxy A07 a recording that ran the disk to zero was reported as "the audio could not be
   * saved" instead of "the phone ran out of space".
   */
  fun reasonAfterFailure(endReason: String, cause: Throwable? = null): String =
    when {
      endReason != RecordingService.END_NORMAL -> endReason
      isOutOfSpace(cause) -> RecordingService.END_DISK_FULL
      else -> RecordingService.END_WRITE_FAILED
    }

  /** Whether [e], or anything it was caused by, is the OS saying the disk is full (ENOSPC). */
  fun isOutOfSpace(e: Throwable?): Boolean {
    var c = e
    var depth = 0
    while (c != null && depth++ < 8) {
      val m = c.message ?: ""
      if (m.contains("ENOSPC") || m.contains("No space left", ignoreCase = true)) return true
      c = c.cause
    }
    return false
  }
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
      CaptureEnd.reasonAfterFailure(reason, e)
    }
    if (reason != RecordingService.END_NORMAL) stopSelf()
    return reason
  }
}
