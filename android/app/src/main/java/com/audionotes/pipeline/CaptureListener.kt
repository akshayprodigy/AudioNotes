package com.audionotes.pipeline

/**
 * Push notification of capture state, for surfaces that cannot poll.
 *
 * The RN layer polls happily — it already re-reads `currentSession()` on every resume — but the
 * notification, the floating bubble and the Quick Settings tile are all drawn from outside any
 * React context and have no frame loop of their own. Before this they either re-read
 * [CaptureController] on a timer (the bubble ran a 1 Hz ticker whether or not anything was
 * recording) or simply went stale (the notification's text was only correct because a separate
 * timer happened to rebuild it).
 *
 * Every callback is delivered on the main thread. That is not a convenience: `silenced` is written
 * from an AudioManager callback on a binder thread and `level` from the capture worker, so a
 * listener that touches a View would otherwise be updating the UI from the wrong thread
 * intermittently — the worst kind of intermittently, because it usually works.
 */
interface CaptureListener {
  /** Recording started. */
  fun onCaptureStarted(meetingId: String) {}

  /**
   * Recording ended, for [reason]. Fires exactly once per session, on every path out — user stop,
   * mic loss, write failure, service death. Surfaces that hide themselves when idle should do it
   * here rather than by noticing `isRecording` went false, which cannot distinguish "finished" from
   * "still flushing".
   */
  fun onCaptureEnded(meetingId: String, reason: String) {}

  /** Pause toggled. */
  fun onPausedChanged(paused: Boolean) {}

  /** The system muted or unmuted our input (call, privacy toggle, another app took the mic). */
  fun onSilencedChanged(silenced: Boolean) {}
}
