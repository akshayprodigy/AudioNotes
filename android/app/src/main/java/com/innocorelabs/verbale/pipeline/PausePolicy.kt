package com.innocorelabs.verbale.pipeline

/**
 * How long a recording may sit paused (addendum R6, GAP-7). A forgotten pause holds a Free slot, a
 * microphone session and a foreground service; after half an hour the notification asks, and after
 * an hour the recording ends — kept and queued, never discarded. Both numbers are starting guesses
 * to be retuned from real use.
 *
 * Pure: no clock, no Android. The capture loop passes in how long the CURRENT pause has lasted,
 * not the meeting's total paused time.
 */
object PausePolicy {
  const val ASK_AFTER_MS = 30 * 60_000L
  const val END_AFTER_MS = 60 * 60_000L

  enum class Action { NONE, ASK, END }

  fun action(pausedForMs: Long): Action = when {
    pausedForMs >= END_AFTER_MS -> Action.END
    pausedForMs >= ASK_AFTER_MS -> Action.ASK
    else -> Action.NONE
  }
}
