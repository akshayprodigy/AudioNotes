package com.innocorelabs.verbale.billing

import com.innocorelabs.verbale.billing.AllowancePolicy.Decision
import com.innocorelabs.verbale.billing.AllowancePolicy.Entry
import com.innocorelabs.verbale.billing.AllowancePolicy.State
import java.util.Calendar
import java.util.TimeZone
import org.junit.Assert.assertEquals
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

  @Test fun `settle - a minute commits, nothing refunds, short waits for the transcript`() {
    val s = AllowancePolicy::settleAction
    assertEquals(AllowancePolicy.Settle.COMMIT, s(60_000L, false, false))
    assertEquals(AllowancePolicy.Settle.WAIT, s(59_999L, false, false))
    assertEquals(AllowancePolicy.Settle.COMMIT, s(30_000L, true, true))
    assertEquals(AllowancePolicy.Settle.REFUND, s(30_000L, false, true))
    assertEquals(AllowancePolicy.Settle.REFUND, s(0L, false, false))
  }
}
