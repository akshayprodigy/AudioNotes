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

  /** A Free import may overrun the hour by this much: the cap's own one-second check cadence (GAP-6). */
  const val IMPORT_TOLERANCE_MS = 1_000L

  /** A transcript is "usable" once one utterance has this many words — a cough is not a meeting (GAP-1). */
  const val USABLE_MIN_WORDS = 3

  enum class State { RESERVED, COMMITTED, REFUNDED }

  data class Entry(val id: String, val period: String, val state: State)

  sealed class Decision {
    data class Granted(val period: String) : Decision()
    data class Denied(val period: String, val resetsOn: String) : Decision()
  }

  enum class Settle { COMMIT, REFUND, WAIT }

  enum class ImportVerdict { OK, TOO_LONG }

  fun periodOf(epochMs: Long, zone: TimeZone): String {
    val c = Calendar.getInstance(zone, Locale.ROOT).apply { timeInMillis = epochMs }
    return String.format(Locale.ROOT, "%04d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1)
  }

  private fun counts(e: Entry) = e.state != State.REFUNDED

  /** The month after [period], "YYYY-MM". */
  fun nextPeriod(period: String): String {
    val year = period.substring(0, 4).toInt()
    val month = period.substring(5, 7).toInt()
    return if (month == 12) String.format(Locale.ROOT, "%04d-01", year + 1)
    else String.format(Locale.ROOT, "%04d-%02d", year, month + 1)
  }

  /**
   * The month a counted entry is read in. Its own, unless it lies more than one month ahead of the
   * phone's clock — then it is read as the current month (GAP-8). A clock excursion (wound forward,
   * a slot taken, corrected) therefore costs at most the following month, never a year; and a clock
   * wound back far enough to put real sessions "in the future" still counts them against the month
   * it shows, so the user is not handed slots. An entry's own [Entry.period] is never rewritten: it
   * is whatever string was stored at reservation, so crossing a time zone moves nothing.
   */
  fun readPeriod(entryPeriod: String, nowPeriod: String): String =
    if (entryPeriod > nextPeriod(nowPeriod)) nowPeriod else entryPeriod

  /**
   * The period the allowance is read in: the later of "now" and the latest read period of any
   * counted entry. A clock wound back up to a month therefore cannot reopen a month already spent.
   * A refunded entry never moves it.
   */
  fun effectivePeriod(nowPeriod: String, entries: List<Entry>): String {
    val latest = entries.filter(::counts).maxOfOrNull { readPeriod(it.period, nowPeriod) } ?: return nowPeriod
    return if (latest > nowPeriod) latest else nowPeriod
  }

  /** Counted sessions in the period the allowance is read in, given the phone's current month. */
  fun used(entries: List<Entry>, nowPeriod: String): Int {
    val period = effectivePeriod(nowPeriod, entries)
    return entries.count { counts(it) && readPeriod(it.period, nowPeriod) == period }
  }

  fun remaining(entries: List<Entry>, nowPeriod: String): Int =
    (FREE_SESSIONS - used(entries, nowPeriod)).coerceAtLeast(0)

  /** First day of the month after [period], "YYYY-MM-DD". */
  fun resetsOn(period: String): String = nextPeriod(period) + "-01"

  fun decide(entries: List<Entry>, nowMs: Long, zone: TimeZone): Decision {
    val nowPeriod = periodOf(nowMs, zone)
    val period = effectivePeriod(nowPeriod, entries)
    return if (remaining(entries, nowPeriod) > 0) Decision.Granted(period)
    else Decision.Denied(period, resetsOn(period))
  }

  /**
   * What to do with a RESERVED slot once something is known about the session. First matching row
   * wins (addendum R1-R2):
   *  - nothing captured: REFUND;
   *  - a dictation under a minute: REFUND at once, whatever it said (founder, GAP-2);
   *  - speech detection has run and found no speech: REFUND, at any length ("empty");
   *  - a minute or more of audio with speech found: COMMIT; speech detection not yet done: WAIT;
   *  - a shorter meeting: the transcript decides once processing has finished (COMMIT if usable,
   *    REFUND if not), and until then WAIT.
   * [vadDone]/[speechFound] come from the speech-detection stage (about 0.01x real time), so an
   * accidental tap gives its slot back within seconds rather than after a full transcription.
   * A crash is not a reason to refund: only a completed run says "no speech" or "not usable".
   */
  fun settleAction(
    capturedMs: Long,
    isDictation: Boolean,
    vadDone: Boolean,
    speechFound: Boolean,
    usableTranscript: Boolean,
    processingDone: Boolean,
  ): Settle = when {
    capturedMs <= 0L -> Settle.REFUND
    isDictation && capturedMs < COMMIT_AFTER_MS -> Settle.REFUND
    vadDone && !speechFound -> Settle.REFUND
    capturedMs >= COMMIT_AFTER_MS && vadDone && speechFound -> Settle.COMMIT
    capturedMs >= COMMIT_AFTER_MS -> Settle.WAIT
    processingDone && usableTranscript -> Settle.COMMIT
    processingDone -> Settle.REFUND
    else -> Settle.WAIT
  }

  /** Whether one utterance's text is enough to call a transcript usable: three words, not three marks. */
  fun isUsableText(text: String): Boolean =
    text.split(Regex("\\s+")).count { w -> w.any { it.isLetterOrDigit() } } >= USABLE_MIN_WORDS

  /**
   * Whether an import may be accepted. [durationMs] is the DECODED length (an import has no capture;
   * a container header that disagrees is overruled by the decode); 0 means unknown and is let
   * through to be decided after decode. A Free file may overrun the hour by [IMPORT_TOLERANCE_MS].
   */
  fun importVerdict(paid: Boolean, durationMs: Long): ImportVerdict =
    if (!paid && durationMs > FREE_DURATION_MS + IMPORT_TOLERANCE_MS) ImportVerdict.TOO_LONG else ImportVerdict.OK

  /** The higher-priority of two ledger states for one id: the state that uses more allowance wins (GAP-9). */
  fun mergeState(local: State, incoming: State): State =
    if (priority(incoming) > priority(local)) incoming else local

  /** COMMITTED > RESERVED > REFUNDED. BackupManager builds its SQL from this, so the two cannot drift. */
  fun priority(s: State): Int = when (s) {
    State.COMMITTED -> 3
    State.RESERVED -> 2
    State.REFUNDED -> 1
  }
}
