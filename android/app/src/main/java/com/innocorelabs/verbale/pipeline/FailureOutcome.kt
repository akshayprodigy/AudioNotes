package com.innocorelabs.verbale.pipeline

/**
 * What a crashed processing run does to its meeting, decided without a database or a phone.
 *
 * [ProcessingEngine.run]'s catch block used to build the reason inline and let
 * `AudioDb.markFailed` do the counting in SQL (`fail_count = fail_count + 1`), so none of it could
 * be held by a JVM test. The decision is here; the UPDATE stays in `AudioDb.markFailed` and is
 * device-only. [MAX_STRIKES] mirrors `fail_count < 3` in `PENDING_MEETINGS_SQL`
 * (src/db/queries.ts): the sweep stops re-queueing a meeting at the third strike.
 */
data class FailureOutcome(
  val status: String,
  val reason: String,
  val newFailCount: Int,
  /** True while the next sweep will queue this meeting again. */
  val retriable: Boolean,
) {
  companion object {
    const val STATUS = "failed"
    const val MAX_STRIKES = 3

    fun of(e: Throwable, failCountSoFar: Int): FailureOutcome {
      val next = failCountSoFar + 1
      return FailureOutcome(STATUS, FailureReason.of(e), next, next < MAX_STRIKES)
    }
  }
}
