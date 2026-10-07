package com.innocorelabs.verbale.billing

import com.innocorelabs.verbale.billing.AllowancePolicy.Decision
import com.innocorelabs.verbale.billing.AllowancePolicy.Entry
import com.innocorelabs.verbale.billing.AllowancePolicy.Settle
import com.innocorelabs.verbale.billing.AllowancePolicy.State
import java.util.TimeZone

/**
 * Takes, keeps and gives back Free slots, over whatever [Store] holds the ledger.
 *
 * The rules live in [AllowancePolicy]; this is only the sequence — read, decide, write — done
 * inside [Store.atomically] so that two starts racing for the last slot cannot both get it. A paid
 * session takes no slot and writes nothing: its entitlement at the start is what lifts the cap
 * (CaptureController), and it must not use up the month's Free sessions.
 */
object Allowance {
  interface Store {
    fun <T> atomically(block: () -> T): T
    fun entries(): List<Entry>
    fun insert(entry: Entry, reservedAtMs: Long)
    fun setState(id: String, state: State)
  }

  sealed class Reservation {
    data class Free(val period: String) : Reservation()
    object Unlimited : Reservation()
    data class Denied(val resetsOn: String) : Reservation()
  }

  data class Status(
    val limit: Int,
    val used: Int,
    val remaining: Int,
    val period: String,
    val resetsOn: String,
    val paid: Boolean,
  )

  fun reserve(store: Store, id: String, paid: Boolean, nowMs: Long, zone: TimeZone): Reservation {
    if (paid) return Reservation.Unlimited
    return store.atomically {
      val entries = store.entries()
      // A duplicate start event for the same session must not take a second slot.
      entries.firstOrNull { it.id == id }?.let { return@atomically Reservation.Free(it.period) }
      when (val d = AllowancePolicy.decide(entries, nowMs, zone)) {
        is Decision.Denied -> Reservation.Denied(d.resetsOn)
        is Decision.Granted -> {
          store.insert(Entry(id, d.period, State.RESERVED), nowMs)
          Reservation.Free(d.period)
        }
      }
    }
  }

  /** RESERVED → COMMITTED. Anything else is left alone. */
  fun commit(store: Store, id: String) = move(store, id, State.COMMITTED)

  /** RESERVED → REFUNDED. A committed session is never un-counted. */
  fun refund(store: Store, id: String) = move(store, id, State.REFUNDED)

  private fun move(store: Store, id: String, to: State) = store.atomically {
    if (store.entries().firstOrNull { it.id == id }?.state == State.RESERVED) store.setState(id, to)
  }

  fun settle(
    store: Store,
    id: String,
    capturedMs: Long,
    isDictation: Boolean,
    vadDone: Boolean,
    speechFound: Boolean,
    usableTranscript: Boolean,
    processingDone: Boolean,
  ) {
    when (AllowancePolicy.settleAction(capturedMs, isDictation, vadDone, speechFound, usableTranscript, processingDone)) {
      Settle.COMMIT -> commit(store, id)
      Settle.REFUND -> refund(store, id)
      Settle.WAIT -> Unit
    }
  }

  fun status(store: Store, paid: Boolean, nowMs: Long, zone: TimeZone): Status {
    val entries = store.entries()
    val nowPeriod = AllowancePolicy.periodOf(nowMs, zone)
    val period = AllowancePolicy.effectivePeriod(nowPeriod, entries)
    return Status(
      limit = AllowancePolicy.FREE_SESSIONS,
      used = AllowancePolicy.used(entries, nowPeriod),
      remaining = AllowancePolicy.remaining(entries, nowPeriod),
      period = period,
      resetsOn = AllowancePolicy.resetsOn(period),
      paid = paid,
    )
  }
}
