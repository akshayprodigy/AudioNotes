package com.innocorelabs.verbale.billing

import com.innocorelabs.verbale.billing.AllowancePolicy.Decision
import com.innocorelabs.verbale.billing.AllowancePolicy.Entry
import com.innocorelabs.verbale.billing.AllowancePolicy.ImportVerdict
import com.innocorelabs.verbale.billing.AllowancePolicy.Settle
import com.innocorelabs.verbale.billing.AllowancePolicy.State
import java.util.Calendar
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AllowancePolicyTest {
  private val utc = TimeZone.getTimeZone("UTC")
  private fun at(y: Int, m: Int, d: Int, h: Int = 12): Long =
    Calendar.getInstance(utc).apply { clear(); set(y, m - 1, d, h, 0, 0) }.timeInMillis
  private fun e(id: String, period: String, s: State = State.COMMITTED) = Entry(id, period, s)

  @Test fun `the free numbers are five sessions and one hour`() {
    assertEquals(5, AllowancePolicy.FREE_SESSIONS)
    assertEquals(3_600_000L, AllowancePolicy.FREE_DURATION_MS)
  }

  @Test fun `a period is the local calendar month`() {
    assertEquals("2026-10", AllowancePolicy.periodOf(at(2026, 10, 7), utc))
    val kolkata = TimeZone.getTimeZone("Asia/Kolkata")
    val instant = at(2026, 10, 31, 23) // 23:00 UTC on 31 Oct = 04:30 on 1 Nov in Kolkata
    assertEquals("2026-10", AllowancePolicy.periodOf(instant, utc))
    assertEquals("2026-11", AllowancePolicy.periodOf(instant, kolkata))
  }

  @Test fun `the fifth session is granted and the sixth is denied with the reset date`() {
    val now = at(2026, 10, 7)
    val four = (1..4).map { e("m$it", "2026-10") }
    assertEquals(Decision.Granted("2026-10"), AllowancePolicy.decide(four, now, utc))
    val five = (1..5).map { e("m$it", "2026-10") }
    assertEquals(Decision.Denied("2026-10", "2026-11-01"), AllowancePolicy.decide(five, now, utc))
  }

  @Test fun `a refunded entry does not count and a reserved one does`() {
    val es = listOf(e("a", "2026-10"), e("b", "2026-10", State.REFUNDED), e("c", "2026-10", State.RESERVED))
    assertEquals(2, AllowancePolicy.used(es, "2026-10"))
    assertEquals(3, AllowancePolicy.remaining(es, "2026-10"))
  }

  @Test fun `last month's sessions do not count this month`() {
    val es = (1..5).map { e("m$it", "2026-09") }
    assertEquals(Decision.Granted("2026-10"), AllowancePolicy.decide(es, at(2026, 10, 1), utc))
    assertEquals(5, AllowancePolicy.remaining(es, "2026-10"))
  }

  @Test fun `rolling the clock back never grants a second reset`() {
    val es = (1..5).map { e("m$it", "2026-10") }
    assertEquals(Decision.Denied("2026-10", "2026-11-01"), AllowancePolicy.decide(es, at(2026, 9, 15), utc))
  }

  @Test fun `a refunded entry in a future month does not push the period forward`() {
    assertEquals("2026-10", AllowancePolicy.effectivePeriod("2026-10", listOf(e("x", "2027-03", State.REFUNDED))))
  }

  @Test fun `reset date rolls the year after December`() {
    assertEquals("2027-01-01", AllowancePolicy.resetsOn("2026-12"))
    assertEquals("2026-11-01", AllowancePolicy.resetsOn("2026-10"))
  }

  @Test fun `five used in October and the clock set back to September is still denied`() {
    val es = (1..5).map { e("m$it", "2026-10") }
    assertEquals(Decision.Denied("2026-10", "2026-11-01"), AllowancePolicy.decide(es, at(2026, 9, 15), utc))
  }

  @Test fun `five used in October and the clock set back to August is still denied`() {
    // October is two months ahead of August, so those sessions are read as August's — counted, not forgiven.
    val es = (1..5).map { e("m$it", "2026-10") }
    assertEquals(Decision.Denied("2026-08", "2026-09-01"), AllowancePolicy.decide(es, at(2026, 8, 15), utc))
  }

  @Test fun `next period rolls the year`() {
    assertEquals("2027-01", AllowancePolicy.nextPeriod("2026-12"))
    assertEquals("2026-11", AllowancePolicy.nextPeriod("2026-10"))
  }

  @Test fun `a session taken under a clock set to January 2027 is read by how far ahead it is`() {
    val es = listOf(e("jan", "2027-01"))
    // Back in October: January is more than a month ahead, so it is October's (one used, four left).
    assertEquals("2026-10", AllowancePolicy.effectivePeriod("2026-10", es))
    assertEquals(1, AllowancePolicy.used(es, "2026-10"))
    assertEquals(4, AllowancePolicy.remaining(es, "2026-10"))
    // November: still two months ahead, so November's.
    assertEquals("2026-11", AllowancePolicy.effectivePeriod("2026-11", es))
    assertEquals(1, AllowancePolicy.used(es, "2026-11"))
    // December: January is next month, so it is read as January — December itself is not charged.
    assertEquals("2027-01", AllowancePolicy.effectivePeriod("2026-12", es))
    assertEquals(1, AllowancePolicy.used(es, "2026-12"))
    assertEquals(Decision.Granted("2027-01"), AllowancePolicy.decide(es, at(2026, 12, 20), utc))
  }

  @Test fun `a forward excursion locks recording for at most the following month`() {
    val five = (1..5).map { e("m$it", "2026-11") } // taken with the clock wound to November
    assertEquals(Decision.Denied("2026-11", "2026-12-01"), AllowancePolicy.decide(five, at(2026, 10, 7), utc))
    // Two months on the excursion has ended: they are read as the then-current month, not an open door.
    assertEquals(Decision.Denied("2026-11", "2026-12-01"), AllowancePolicy.decide(five, at(2026, 11, 2), utc))
    assertEquals(Decision.Granted("2026-12"), AllowancePolicy.decide(five, at(2026, 12, 2), utc))
  }

  @Test fun `a refunded entry never moves the period, however far ahead`() {
    val es = listOf(e("x", "2027-01", State.REFUNDED), e("y", "2026-10"))
    assertEquals("2026-10", AllowancePolicy.effectivePeriod("2026-10", es))
    assertEquals(1, AllowancePolicy.used(es, "2026-10"))
  }

  @Test fun `an entry keeps the period it was reserved in - a new time zone moves nothing`() {
    // Reserved 31 Oct 23:00 UTC: October in UTC. The phone then travels to Kolkata, where it is
    // already 1 November: the entry still says October, and is read as the previous month, not re-derived.
    val instant = at(2026, 10, 31, 23)
    val stored = AllowancePolicy.periodOf(instant, utc)
    val es = listOf(e("late", stored))
    val kolkata = TimeZone.getTimeZone("Asia/Kolkata")
    assertEquals(0, AllowancePolicy.used(es, AllowancePolicy.periodOf(instant, kolkata)))
    assertEquals("2026-10", es[0].period)
  }

  @Test fun `settle - nothing captured is always refunded`() {
    val s = AllowancePolicy::settleAction
    assertEquals(Settle.REFUND, s(0L, false, false, false, false, false))
    assertEquals(Settle.REFUND, s(0L, true, true, true, true, true))
  }

  @Test fun `settle - a dictation under a minute is refunded at once whatever it said`() {
    val s = AllowancePolicy::settleAction
    assertEquals(Settle.REFUND, s(59_999L, true, false, false, false, false)) // before anything ran
    assertEquals(Settle.REFUND, s(30_000L, true, true, true, true, true))     // real words, still free
    assertEquals(Settle.COMMIT, s(60_000L, true, true, true, false, false))   // a minute counts like any session
  }

  @Test fun `settle - no speech found refunds at any length`() {
    val s = AllowancePolicy::settleAction
    assertEquals(Settle.REFUND, s(10_000L, false, true, false, false, false))
    assertEquals(Settle.REFUND, s(45 * 60_000L, false, true, false, false, false))
  }

  @Test fun `settle - a minute with speech found commits before transcription, and waits for the speech check`() {
    val s = AllowancePolicy::settleAction
    assertEquals(Settle.COMMIT, s(60_000L, false, true, true, false, false))
    assertEquals(Settle.WAIT, s(60_000L, false, false, false, false, false))
    assertEquals(Settle.WAIT, s(10 * 60_000L, false, false, false, false, true)) // processing "done" without the VAD verdict: keep waiting
  }

  @Test fun `settle - a short meeting waits for processing, then the transcript decides`() {
    val s = AllowancePolicy::settleAction
    assertEquals(Settle.WAIT, s(30_000L, false, false, false, false, false))
    assertEquals(Settle.WAIT, s(30_000L, false, true, true, true, false))   // speech found, not finished yet
    assertEquals(Settle.COMMIT, s(30_000L, false, true, true, true, true))
    assertEquals(Settle.REFUND, s(30_000L, false, true, true, false, true)) // finished, nothing usable
  }

  @Test fun `settle - a short meeting just under a minute still waits`() {
    assertEquals(Settle.WAIT, AllowancePolicy.settleAction(59_999L, false, true, true, false, false))
    assertEquals(Settle.COMMIT, AllowancePolicy.settleAction(60_000L, false, true, true, false, false))
  }

  @Test fun `usable text is three words, not three marks`() {
    assertTrue(AllowancePolicy.isUsableText("we ship thursday"))
    assertTrue(AllowancePolicy.isUsableText("  call   Sam 5 "))
    assertFalse(AllowancePolicy.isUsableText("okay thanks"))
    assertFalse(AllowancePolicy.isUsableText("yes"))
    assertFalse(AllowancePolicy.isUsableText("... - ..."))
    assertFalse(AllowancePolicy.isUsableText(""))
  }

  @Test fun `the ledger merge keeps the state that uses more allowance - all nine pairs`() {
    val R = State.RESERVED; val C = State.COMMITTED; val F = State.REFUNDED
    val m = AllowancePolicy::mergeState
    // (local, incoming) -> winner
    assertEquals(C, m(C, C)); assertEquals(C, m(C, R)); assertEquals(C, m(C, F))
    assertEquals(C, m(R, C)); assertEquals(R, m(R, R)); assertEquals(R, m(R, F))
    assertEquals(C, m(F, C)); assertEquals(R, m(F, R)); assertEquals(F, m(F, F))
  }

  @Test fun `an import is refused only when a free file is over an hour and a second`() {
    assertEquals(ImportVerdict.OK, AllowancePolicy.importVerdict(false, 3_601_000L))
    assertEquals(ImportVerdict.TOO_LONG, AllowancePolicy.importVerdict(false, 3_601_001L))
    assertEquals(ImportVerdict.OK, AllowancePolicy.importVerdict(false, 0L)) // unknown: decided after decode
    assertEquals(ImportVerdict.OK, AllowancePolicy.importVerdict(true, 10 * 3_600_000L))
  }
}
