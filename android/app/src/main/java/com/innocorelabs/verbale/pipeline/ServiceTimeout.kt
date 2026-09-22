package com.innocorelabs.verbale.pipeline

/**
 * What to say when Android stops processing at its six-hour foreground-service limit.
 *
 * Android 15 (API 35) allows a dataSync foreground service six hours in any 24 and then calls
 * Service.onTimeout; the app must be stopped seconds later or it is killed with
 * ForegroundServiceDidNotStopInTimeException. Narration measured 3.9x realtime on a Helio G99, so
 * a long meeting reaches this honestly rather than through a bug.
 *
 * The work is not lost: stage rows are committed as they land and ResumePlan re-plans what is
 * left, so the next foreground sweep carries on. This object decides only whether there is
 * anything to tell the person, and in what words — the part worth a test.
 */
object ServiceTimeout {
  data class Notice(val title: String, val text: String)

  /**
   * [running] is the meeting in the engine when the limit hit, [queued] how many were waiting.
   * Null when nothing was in flight: the service being stopped with an empty queue is not news,
   * and a notification for it would be a lie about work that was not happening.
   */
  fun notice(running: String?, queued: Int): Notice? {
    if (running == null && queued == 0) return null
    val more = if (queued > 0) " $queued more ${if (queued == 1) "meeting is" else "meetings are"} waiting." else ""
    return Notice(
      "Paused for today",
      "Android limits background work to six hours a day and has stopped this one." +
        " Open Verbale to carry on where it left off.$more",
    )
  }
}
