package com.innocorelabs.verbale.billing

import com.innocorelabs.verbale.billing.AllowancePolicy.Entry
import com.innocorelabs.verbale.billing.AllowancePolicy.State
import java.util.Calendar
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeStore : Allowance.Store {
  val rows = linkedMapOf<String, Entry>()
  var atomicDepth = 0
  override fun <T> atomically(block: () -> T): T {
    atomicDepth++
    try { return block() } finally { atomicDepth-- }
  }
  override fun entries() = rows.values.toList()
  override fun insert(entry: Entry, reservedAtMs: Long) {
    check(atomicDepth > 0) { "insert outside a transaction" }
    check(entry.id !in rows) { "duplicate primary key ${entry.id}" }
    rows[entry.id] = entry
  }
  override fun setState(id: String, state: State) {
    rows[id]?.let { rows[id] = it.copy(state = state) }
  }
}

class AllowanceTest {
  private val utc = TimeZone.getTimeZone("UTC")
  private fun at(y: Int, m: Int, d: Int) =
    Calendar.getInstance(utc).apply { clear(); set(y, m - 1, d, 12, 0, 0) }.timeInMillis
  private val oct = at(2026, 10, 7)

  @Test fun `five free sessions are reserved and the sixth is refused`() {
    val s = FakeStore()
    (1..5).forEach { assertTrue(Allowance.reserve(s, "m$it", false, oct, utc) is Allowance.Reservation.Free) }
    assertEquals(Allowance.Reservation.Denied("2026-11-01"), Allowance.reserve(s, "m6", false, oct, utc))
    assertEquals(5, s.rows.size) // a refusal writes nothing
  }

  @Test fun `a reservation is atomic - the insert happens inside the transaction`() {
    val s = FakeStore()
    Allowance.reserve(s, "m1", false, oct, utc) // FakeStore.insert throws outside atomically
    assertEquals(1, s.rows.size)
  }

  @Test fun `the same session id twice takes one slot`() {
    val s = FakeStore()
    Allowance.reserve(s, "m1", false, oct, utc)
    Allowance.reserve(s, "m1", false, oct, utc)
    assertEquals(1, s.rows.size)
  }

  @Test fun `a duplicate start event for a session that holds the last slot is not refused`() {
    val s = FakeStore()
    (1..5).forEach { Allowance.reserve(s, "m$it", false, oct, utc) }
    assertEquals(Allowance.Reservation.Free("2026-10"), Allowance.reserve(s, "m5", false, oct, utc))
    assertEquals(5, s.rows.size)
  }

  @Test fun `a paid session takes no slot and is never refused`() {
    val s = FakeStore()
    (1..5).forEach { Allowance.reserve(s, "f$it", false, oct, utc) }
    assertEquals(Allowance.Reservation.Unlimited, Allowance.reserve(s, "pro", true, oct, utc))
    assertEquals(5, s.rows.size)
  }

  @Test fun `refund frees the slot but never un-commits one`() {
    val s = FakeStore()
    Allowance.reserve(s, "a", false, oct, utc)
    Allowance.reserve(s, "b", false, oct, utc)
    Allowance.commit(s, "a")
    Allowance.refund(s, "a")
    Allowance.refund(s, "b")
    assertEquals(State.COMMITTED, s.rows["a"]!!.state)
    assertEquals(State.REFUNDED, s.rows["b"]!!.state)
  }

  @Test fun `a recording that crosses into a new month is charged to the month it began in`() {
    val s = FakeStore()
    Allowance.reserve(s, "late", false, at(2026, 10, 31), utc)
    Allowance.commit(s, "late")
    assertEquals("2026-10", s.rows["late"]!!.period)
    assertEquals(5, Allowance.status(s, false, at(2026, 11, 1), utc).remaining)
  }

  @Test fun `status reports used, remaining and the reset date`() {
    val s = FakeStore()
    Allowance.reserve(s, "a", false, oct, utc)
    Allowance.reserve(s, "b", false, oct, utc)
    val st = Allowance.status(s, false, oct, utc)
    assertEquals(AllowancePolicy.FREE_SESSIONS, st.limit)
    assertEquals(2, st.used)
    assertEquals(3, st.remaining)
    assertEquals("2026-11-01", st.resetsOn)
    assertEquals(false, st.paid)
  }

  @Test fun `settle applies the policy's verdict`() {
    val s = FakeStore()
    Allowance.reserve(s, "long", false, oct, utc)
    Allowance.reserve(s, "blip", false, oct, utc)
    Allowance.settle(s, "long", capturedMs = 120_000L, usableTranscript = false, processingDone = false)
    Allowance.settle(s, "blip", capturedMs = 5_000L, usableTranscript = false, processingDone = true)
    assertEquals(State.COMMITTED, s.rows["long"]!!.state)
    assertEquals(State.REFUNDED, s.rows["blip"]!!.state)
  }
}
