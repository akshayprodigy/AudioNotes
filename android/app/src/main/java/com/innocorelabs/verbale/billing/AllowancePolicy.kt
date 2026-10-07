package com.innocorelabs.verbale.billing

import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * The Free tier's allowance: five counted sessions per calendar month, each up to one hour of
 * captured audio. Mirrors docs/PRODUCT_IMPROVEMENT_PLAN_2026-10.md §3.
 *
 * Pure: no clock, no Android, no database. Callers pass the time, the zone and the ledger rows in,
 * which is what lets every rule here run on the JVM. No java.time — minSdk is 24.
 *
 * A "period" is "YYYY-MM" in the device's local calendar. Strings of that shape sort
 * chronologically, which the clock-rollback rule relies on.
 */
object AllowancePolicy {
  const val FREE_SESSIONS = 5

  /** Captured audio per Free session, pauses excluded. */
  const val FREE_DURATION_MS = 60L * 60_000L

  /** A session with this much audio is a real one: it takes a slot whatever processing does. */
  const val COMMIT_AFTER_MS = 60_000L

  enum class State { RESERVED, COMMITTED, REFUNDED }

  data class Entry(val id: String, val period: String, val state: State)

  sealed class Decision {
    data class Granted(val period: String) : Decision()
    data class Denied(val period: String, val resetsOn: String) : Decision()
  }

  enum class Settle { COMMIT, REFUND, WAIT }

  fun periodOf(epochMs: Long, zone: TimeZone): String {
    val c = Calendar.getInstance(zone, Locale.ROOT).apply { timeInMillis = epochMs }
    return String.format(Locale.ROOT, "%04d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1)
  }

  private fun counts(e: Entry) = e.state != State.REFUNDED

  /**
   * The period the allowance is read in: the later of "now" and the latest period that holds a
   * counted entry. A clock wound back therefore cannot reopen a month already spent. A clock wound
   * forward and then corrected leaves one counted entry in the future, which only means that month's
   * tally is read early — it never locks anyone out of saved content.
   */
  fun effectivePeriod(nowPeriod: String, entries: List<Entry>): String {
    val latest = entries.filter(::counts).maxOfOrNull { it.period } ?: return nowPeriod
    return if (latest > nowPeriod) latest else nowPeriod
  }

  fun used(entries: List<Entry>, period: String): Int =
    entries.count { counts(it) && it.period == period }

  fun remaining(entries: List<Entry>, period: String): Int =
    (FREE_SESSIONS - used(entries, period)).coerceAtLeast(0)

  /** First day of the month after [period], "YYYY-MM-DD". */
  fun resetsOn(period: String): String {
    val year = period.substring(0, 4).toInt()
    val month = period.substring(5, 7).toInt()
    return if (month == 12) String.format(Locale.ROOT, "%04d-01-01", year + 1)
    else String.format(Locale.ROOT, "%04d-%02d-01", year, month + 1)
  }

  fun decide(entries: List<Entry>, nowMs: Long, zone: TimeZone): Decision {
    val period = effectivePeriod(periodOf(nowMs, zone), entries)
    return if (remaining(entries, period) > 0) Decision.Granted(period)
    else Decision.Denied(period, resetsOn(period))
  }

  /**
   * What to do with a RESERVED slot once something is known about the session.
   * [processingDone] is "a processing run has finished" (done or error); [usableTranscript] is
   * "at least one utterance exists". Nothing captured is always refunded; a minute of audio is
   * always kept; in between the transcript decides, and until processing ends we wait.
   */
  fun settleAction(capturedMs: Long, usableTranscript: Boolean, processingDone: Boolean): Settle = when {
    capturedMs <= 0L -> Settle.REFUND
    capturedMs >= COMMIT_AFTER_MS -> Settle.COMMIT
    !processingDone -> Settle.WAIT
    usableTranscript -> Settle.COMMIT
    else -> Settle.REFUND
  }
}
