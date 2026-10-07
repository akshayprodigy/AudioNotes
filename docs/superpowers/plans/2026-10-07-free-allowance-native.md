# Free allowance — native core (Workstream B, part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 15-minute Free recording cap with *five counted sessions per calendar month, each up to 60 minutes of captured audio*, enforced natively, with a durable ledger.

**Architecture:** A pure Kotlin policy (`AllowancePolicy`) and a pure service over a tiny `AllowanceStore` interface (`Allowance`) hold every rule and are JVM-tested. `AudioDb` implements the store over one new SQLCipher table (`allowance`), which backup carries with merge-by-id. `CaptureController.start` and `AudioImport.import` reserve a slot natively *before* capturing/accepting; `RecordingService` commits/refunds on the way out and enforces the 60-minute cap. JS stops deciding the cap and only renders (display work is Part 2).

**Tech Stack:** Kotlin (JUnit4 JVM tests via `./gradlew :app:testDebugUnitTest`), SQLCipher `AudioDb`, React Native bridge, TypeScript + jest.

**Spec:** `docs/PRODUCT_IMPROVEMENT_PLAN_2026-10.md` §3 (allowance) and §4-B. Part 2 (separate plan, after this ships and is device-checked): remaining/reset display in Library/Record/Settings/paywall, exhausted-state UI, free keyword search, store/paywall copy, onboarding.

**Constraints discovered while planning (read before starting):**
- `minSdk` is 24 → `java.time` is NOT available. Use `java.util.Calendar`/`TimeZone` (the policy below does).
- `ShimActivity.quickStart()` (Quick Settings tile / shortcut) calls `CaptureController.start(applicationContext)` with **no cap** — today a Free user records without limit from the tile. The comment in `PipelineController.startRecording` claiming every entry point gets the cap is wrong. Resolving the cap natively inside `start()` fixes this; Task 5 pins it with a test.
- The capture loop checks the cap every `DISK_CHECK_EVERY_READS = 256` reads (≈33 s of audio). A 60-minute limit would overrun by up to 33 s. Task 6 moves the check to the 8-read (≈1 s) cadence.
- Cap is measured from bytes written (`File(path).length() / BYTES_PER_MS`), so pauses are already excluded. Do not change that.
- `BackupManager` restores with `INSERT OR REPLACE`; the ledger needs `INSERT OR IGNORE` (local row wins) — Task 4.
- House rules: mutation-test every new rule (break it, watch a test fail, restore); commit per task; never push; do not touch `cpp/`.

**Files — create:**
- `android/app/src/main/java/com/innocorelabs/verbale/billing/AllowancePolicy.kt` — pure rules.
- `android/app/src/main/java/com/innocorelabs/verbale/billing/Allowance.kt` — reserve/commit/refund/settle over `AllowanceStore`.
- `android/app/src/test/java/com/innocorelabs/verbale/billing/AllowancePolicyTest.kt`
- `android/app/src/test/java/com/innocorelabs/verbale/billing/AllowanceTest.kt`

**Files — modify:**
- `android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt` — `allowance` table in `SCHEMA`; `allowanceStore()`; `settleAllowance()`; `sweepAllowance()`.
- `android/app/src/main/java/com/innocorelabs/verbale/data/BackupManager.kt` — add `allowance` to `TABLES`, ignore-on-conflict verb.
- `android/app/src/main/java/com/innocorelabs/verbale/pipeline/CaptureController.kt` — `start()` reserves + resolves cap; `AllowanceExhausted`.
- `android/app/src/main/java/com/innocorelabs/verbale/pipeline/AudioPipelineModule.kt` — drop JS `capMs`; reject `allowance_exhausted`.
- `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ShimActivity.kt` — exhausted → open app.
- `android/app/src/main/java/com/innocorelabs/verbale/pipeline/CapClock.kt`, `RecordingService.kt` — 5-minute warning, 1-second cap check, settle on capture end.
- `android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingService.kt` — settle after processing.
- `android/app/src/main/java/com/innocorelabs/verbale/audio/AudioImport.kt` — pre-check duration, reserve, refund on failure.
- `src/billing/recordingCap.ts`, `src/pipeline/PipelineController.ts`, `src/screens/recordMode.ts`, `src/screens/RecordScreen.tsx`, `src/screens/PaywallScreen.tsx` + their tests — constants/copy only.
- Existing tests that pin 15 minutes: `CapClockTest.kt`, `recordingCap.test.ts`, `recordMode.test.ts`.

**Files that must not change:** `cpp/**`, `server/**`, anything under `src/pipeline/__tests__/evidence.test.ts` / `minutes.golden.test.ts` (their "fifteen minutes" is meeting *content*, not policy).

---

### Task 0: Baseline

- [ ] **Step 1: Run the checks that this plan will touch, record the result**

Run: `cd /Users/akshayghosh/ReactNative/InnoCoreLabs/AudioNotes && npx jest src/billing src/screens/__tests__/recordMode.test.ts src/pipeline/__tests__/startRecording.test.ts 2>&1 | tail -8 && (cd android && ./gradlew :app:testDebugUnitTest -q 2>&1 | tail -8)`
Expected: all pass. If anything already fails, stop and report it — do not start on a red baseline.

---

### Task 1: Pure policy (`AllowancePolicy`)

**Files:**
- Create: `android/app/src/main/java/com/innocorelabs/verbale/billing/AllowancePolicy.kt`
- Test: `android/app/src/test/java/com/innocorelabs/verbale/billing/AllowancePolicyTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.innocorelabs.verbale.billing

import com.innocorelabs.verbale.billing.AllowancePolicy.Decision
import com.innocorelabs.verbale.billing.AllowancePolicy.Entry
import com.innocorelabs.verbale.billing.AllowancePolicy.State
import java.util.Calendar
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AllowancePolicyTest {
  private val utc = TimeZone.getTimeZone("UTC")
  private fun at(y: Int, m: Int, d: Int, h: Int = 12, zone: TimeZone = utc): Long =
    Calendar.getInstance(zone).apply { clear(); set(y, m - 1, d, h, 0, 0) }.timeInMillis
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
    val now = at(2026, 10, 7)
    val es = listOf(e("a", "2026-10"), e("b", "2026-10", State.REFUNDED), e("c", "2026-10", State.RESERVED))
    assertEquals(2, AllowancePolicy.used(es, "2026-10"))
    assertEquals(3, AllowancePolicy.remaining(es, "2026-10"))
  }

  @Test fun `last month's sessions do not count this month - no rollover, no carry-over of use`() {
    val es = (1..5).map { e("m$it", "2026-09") }
    assertEquals(Decision.Granted("2026-10"), AllowancePolicy.decide(es, at(2026, 10, 1), utc))
    assertEquals(5, AllowancePolicy.remaining(es, "2026-10"))
  }

  @Test fun `rolling the clock back never grants a second reset`() {
    // Five used in October; the clock is wound back to September. Still October's tally.
    val es = (1..5).map { e("m$it", "2026-10") }
    val d = AllowancePolicy.decide(es, at(2026, 9, 15), utc)
    assertEquals(Decision.Denied("2026-10", "2026-11-01"), d)
  }

  @Test fun `a refunded entry in a future month does not push the period forward`() {
    val es = listOf(e("x", "2027-03", State.REFUNDED))
    assertEquals("2026-10", AllowancePolicy.effectivePeriod("2026-10", es))
  }

  @Test fun `reset date rolls the year after December`() {
    assertEquals("2027-01-01", AllowancePolicy.resetsOn("2026-12"))
    assertEquals("2026-11-01", AllowancePolicy.resetsOn("2026-10"))
  }

  @Test fun `settle - at least a minute of audio commits, nothing refunds, short waits for the transcript`() {
    val s = AllowancePolicy::settleAction
    assertEquals(AllowancePolicy.Settle.COMMIT, s(60_000L, false, false))
    assertEquals(AllowancePolicy.Settle.WAIT, s(59_999L, false, false))
    assertEquals(AllowancePolicy.Settle.COMMIT, s(30_000L, true, true))   // short but usable
    assertEquals(AllowancePolicy.Settle.REFUND, s(30_000L, false, true))  // short and empty
    assertEquals(AllowancePolicy.Settle.REFUND, s(0L, false, false))      // nothing captured
  }
}
```

- [ ] **Step 2: Run to see it fail**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests '*AllowancePolicyTest*' -q 2>&1 | tail -15`
Expected: compile FAIL — `Unresolved reference: AllowancePolicy`.

- [ ] **Step 3: Write the implementation**

```kotlin
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
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests '*AllowancePolicyTest*' -q 2>&1 | tail -15`
Expected: PASS (no output with `-q`). Check with `ls android/app/build/test-results/testDebugUnitTest | grep Allowance` that the XML exists and has `failures="0"`.

- [ ] **Step 5: Mutation check**

Change `FREE_SESSIONS - used` to `FREE_SESSIONS + 1 - used` → `the fifth session…` fails. Change `if (latest > nowPeriod) latest else nowPeriod` to `nowPeriod` → `rolling the clock back…` fails. Restore both; re-run green.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/billing/AllowancePolicy.kt android/app/src/test/java/com/innocorelabs/verbale/billing/AllowancePolicyTest.kt
git commit -m "feat(allowance): pure policy — five sessions a month, one hour each, clock-rollback safe"
```

---

### Task 2: Service over a store (`Allowance`)

**Files:**
- Create: `android/app/src/main/java/com/innocorelabs/verbale/billing/Allowance.kt`
- Test: `android/app/src/test/java/com/innocorelabs/verbale/billing/AllowanceTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
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
  override fun <T> atomically(block: () -> T): T { atomicDepth++; try { return block() } finally { atomicDepth-- } }
  override fun entries() = rows.values.toList()
  override fun insert(entry: Entry, reservedAtMs: Long) { check(atomicDepth > 0) { "insert outside a transaction" }; rows[entry.id] = entry }
  override fun setState(id: String, state: State) { rows[id]?.let { rows[id] = it.copy(state = state) } }
}

class AllowanceTest {
  private val utc = TimeZone.getTimeZone("UTC")
  private fun at(y: Int, m: Int, d: Int) =
    Calendar.getInstance(utc).apply { clear(); set(y, m - 1, d, 12, 0, 0) }.timeInMillis
  private val oct = at(2026, 10, 7)

  @Test fun `five free sessions are reserved and the sixth is refused`() {
    val s = FakeStore()
    (1..5).forEach { assertTrue(Allowance.reserve(s, "m$it", false, oct, utc) is Allowance.Reservation.Free) }
    val sixth = Allowance.reserve(s, "m6", false, oct, utc)
    assertEquals(Allowance.Reservation.Denied("2026-11-01"), sixth)
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
    Allowance.refund(s, "a")           // a is committed: stays
    Allowance.refund(s, "b")           // b is reserved: refunded
    assertEquals(State.COMMITTED, s.rows["a"]!!.state)
    assertEquals(State.REFUNDED, s.rows["b"]!!.state)
  }

  @Test fun `a recording that crosses into a new month is charged to the month it began in`() {
    val s = FakeStore()
    Allowance.reserve(s, "late", false, at(2026, 10, 31), utc)
    Allowance.commit(s, "late") // committed in November, still October's
    assertEquals("2026-10", s.rows["late"]!!.period)
    assertEquals(5, Allowance.status(s, false, at(2026, 11, 1), utc).remaining)
  }

  @Test fun `status reports used, remaining and the reset date`() {
    val s = FakeStore()
    Allowance.reserve(s, "a", false, oct, utc); Allowance.reserve(s, "b", false, oct, utc)
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests '*AllowanceTest*' -q 2>&1 | tail -15`
Expected: compile FAIL — `Unresolved reference: Allowance`.

- [ ] **Step 3: Write the implementation**

```kotlin
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

  fun settle(store: Store, id: String, capturedMs: Long, usableTranscript: Boolean, processingDone: Boolean) {
    when (AllowancePolicy.settleAction(capturedMs, usableTranscript, processingDone)) {
      Settle.COMMIT -> commit(store, id)
      Settle.REFUND -> refund(store, id)
      Settle.WAIT -> Unit
    }
  }

  fun status(store: Store, paid: Boolean, nowMs: Long, zone: TimeZone): Status {
    val entries = store.entries()
    val period = AllowancePolicy.effectivePeriod(AllowancePolicy.periodOf(nowMs, zone), entries)
    return Status(
      limit = AllowancePolicy.FREE_SESSIONS,
      used = AllowancePolicy.used(entries, period),
      remaining = AllowancePolicy.remaining(entries, period),
      period = period,
      resetsOn = AllowancePolicy.resetsOn(period),
      paid = paid,
    )
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests '*AllowanceTest*' -q 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Mutation check**

(a) In `reserve`, delete the `firstOrNull { it.id == id }` line → `the same session id twice` fails. (b) In `move`, drop the `== State.RESERVED` check → `refund frees the slot but never un-commits one` fails. (c) Change `if (paid) return Reservation.Unlimited` to fall through → `a paid session takes no slot` fails. Restore all; green.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/billing/Allowance.kt android/app/src/test/java/com/innocorelabs/verbale/billing/AllowanceTest.kt
git commit -m "feat(allowance): reserve/commit/refund/settle over a store, atomic and idempotent"
```

---

### Task 3: The ledger table and `AudioDb` adapter

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt` — `SCHEMA` array (anchor: the line `"CREATE TABLE IF NOT EXISTS asks("`, ~L3157), plus new methods next to `getSetting` (~L754).
- Test: `android/app/src/test/java/com/innocorelabs/verbale/SchemaTest.kt` (DDL smoke), `src/db/__tests__/schema.test.ts` (authoritative DDL; the TS schema mirrors `meetings` etc. — check whether it must list every table; see step 1).

- [ ] **Step 1: Check whether `src/db/schema.ts` is required to mirror every table**

Run: `grep -n "asks\|marks" src/db/schema.ts src/db/__tests__/schema.test.ts | head`
If `asks` appears in `schema.ts`, add the same `allowance` DDL there and a case in `schema.test.ts`; if the TS schema only covers JS-owned tables, skip the TS side and note it in the commit. (The ledger is native-owned.)

- [ ] **Step 2: Write the failing test** — add to `SchemaTest.kt`:

```kotlin
  @Test fun `the allowance ledger has a stable id, a period and a state`() {
    val cols = columnsOf(ddlFor("allowance"))
    assertTrue(cols.containsAll(listOf("id", "period", "state", "reserved_at")))
  }
```
(Use the helper in that file that returns declared column names — it is named in the file's header comment; reuse it, do not write a new parser.)

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests '*SchemaTest*' -q 2>&1 | tail`
Expected: FAIL — `NoSuchElementException` from `ddlFor("allowance")`.

- [ ] **Step 3: Add the table and the adapter**

In `SCHEMA`, after the `asks` entry (before the closing `)`):

```kotlin
      // The Free allowance ledger (docs/PRODUCT_IMPROVEMENT_PLAN_2026-10.md §3). One row per
      // counted session, keyed by the meeting's id so a restore merges instead of adding. NOT a
      // foreign key to meetings: deleting or archiving a counted meeting must not give the slot
      // back. state: RESERVED | COMMITTED | REFUNDED.
      "CREATE TABLE IF NOT EXISTS allowance(" +
        "id TEXT PRIMARY KEY, period TEXT NOT NULL, state TEXT NOT NULL, reserved_at INTEGER NOT NULL);",
```

Next to `getSetting`, add:

```kotlin
  // ---- Free allowance (see billing/Allowance.kt for the rules) ----

  fun allowanceStore(): com.innocorelabs.verbale.billing.Allowance.Store = object : com.innocorelabs.verbale.billing.Allowance.Store {
    override fun <T> atomically(block: () -> T): T {
      db.beginTransaction()
      try {
        val r = block()
        db.setTransactionSuccessful()
        return r
      } finally {
        db.endTransaction()
      }
    }

    override fun entries(): List<com.innocorelabs.verbale.billing.AllowancePolicy.Entry> =
      db.rawQuery("SELECT id, period, state FROM allowance", null).use { c ->
        val out = ArrayList<com.innocorelabs.verbale.billing.AllowancePolicy.Entry>()
        while (c.moveToNext()) {
          val state = runCatching { com.innocorelabs.verbale.billing.AllowancePolicy.State.valueOf(c.getString(2)) }.getOrNull() ?: continue
          out.add(com.innocorelabs.verbale.billing.AllowancePolicy.Entry(c.getString(0), c.getString(1), state))
        }
        out
      }

    override fun insert(entry: com.innocorelabs.verbale.billing.AllowancePolicy.Entry, reservedAtMs: Long) {
      db.execSQL(
        "INSERT OR IGNORE INTO allowance(id, period, state, reserved_at) VALUES(?,?,?,?)",
        arrayOf<Any?>(entry.id, entry.period, entry.state.name, reservedAtMs),
      )
    }

    override fun setState(id: String, state: com.innocorelabs.verbale.billing.AllowancePolicy.State) {
      db.execSQL("UPDATE allowance SET state=? WHERE id=?", arrayOf<Any?>(state.name, id))
    }
  }

  /**
   * Apply the policy's verdict to a session's slot using what the database knows about it.
   * Called when capture ends and again when processing ends.
   */
  fun settleAllowance(meetingId: String, processingDone: Boolean) {
    val capturedMs = db.rawQuery("SELECT duration_ms FROM meetings WHERE id=?", arrayOf(meetingId)).use {
      if (it.moveToFirst()) it.getLong(0) else 0L
    }
    val usable = db.rawQuery("SELECT 1 FROM utterances WHERE meeting_id=? LIMIT 1", arrayOf(meetingId)).use { it.moveToFirst() }
    com.innocorelabs.verbale.billing.Allowance.settle(allowanceStore(), meetingId, capturedMs, usable, processingDone)
  }

  /**
   * Settle every slot still RESERVED, for a process that died mid-session. A reservation whose
   * meeting row is gone is refunded; the rest are judged from the file and the transcript. Call it
   * when no capture is running.
   */
  fun sweepAllowance() {
    val store = allowanceStore()
    for (e in store.entries().filter { it.state == com.innocorelabs.verbale.billing.AllowancePolicy.State.RESERVED }) {
      val row = db.rawQuery("SELECT status FROM meetings WHERE id=?", arrayOf(e.id)).use {
        if (it.moveToFirst()) it.getString(0) else null
      }
      if (row == null) com.innocorelabs.verbale.billing.Allowance.refund(store, e.id)
      else settleAllowance(e.id, processingDone = row == "done" || row == "error")
    }
  }
```

(Use imports instead of the fully-qualified names if the file already imports from `billing` — match the surrounding style.)

- [ ] **Step 4: Run tests**

Run: `cd android && ./gradlew :app:testDebugUnitTest -q 2>&1 | tail -15`
Expected: PASS, including the new `SchemaTest` case. (The SQL itself cannot run on the JVM — it is device-verified in Task 9; `schemaForTest()` picks the new DDL up automatically.)

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt android/app/src/test/java/com/innocorelabs/verbale/SchemaTest.kt
git commit -m "feat(allowance): encrypted ledger table, transactional store, settle and sweep"
```

---

### Task 4: Backup carries the ledger, merging by id

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/data/BackupManager.kt` — `TABLES` (~L67-70) and the restore loop (~L164-182).
- Test: `android/app/src/test/java/com/innocorelabs/verbale/data/` — find the existing test that uses `tablesForTest()` (`grep -rn tablesForTest android/app/src`), add a case beside it.

- [ ] **Step 1: Write the failing test** (beside the existing `tablesForTest` assertions)

```kotlin
  @Test fun `the allowance ledger travels in a backup`() {
    assertTrue("allowance" in BackupManager.tablesForTest())
  }

  @Test fun `the ledger restores by ignoring rows the device already has`() {
    assertEquals("INSERT OR IGNORE", BackupManager.restoreVerb("allowance"))
    assertEquals("INSERT OR REPLACE", BackupManager.restoreVerb("meetings"))
  }
```

Run the gradle test for that class. Expected: FAIL (`allowance` missing; `restoreVerb` unresolved).

- [ ] **Step 2: Implement**

Add `"allowance"` to `TABLES`. Add next to `tablesForTest`:

```kotlin
  /**
   * The ledger merges: a row this phone already has — possibly further along, COMMITTED where the
   * backup still says RESERVED — wins over the backup's copy. Everything else keeps replacing.
   * A restore must not make the allowance look newer or emptier than the phone knows it to be.
   */
  fun restoreVerb(table: String): String = if (table == "allowance") "INSERT OR IGNORE" else "INSERT OR REPLACE"
```

and change the restore statement to
`db.exec("${restoreVerb(table)} INTO main.$table($list) SELECT $list FROM bak.$table")`.

- [ ] **Step 3: Run tests** — `cd android && ./gradlew :app:testDebugUnitTest -q 2>&1 | tail`. Expected: PASS.

- [ ] **Step 4: Mutation check** — return `INSERT OR REPLACE` for every table → the `restoreVerb` test fails. Restore.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/innocorelabs/verbale/data/BackupManager.kt android/app/src/test
git commit -m "feat(allowance): backup carries the ledger and merges it by session id"
```

---

### Task 5: Native start reserves a slot and decides the cap (closes the tile hole)

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/CaptureController.kt` — `start()` (~L387-425).
- Modify: `AudioPipelineModule.kt` (~L155-175), `ShimActivity.kt` (~L55-75).
- Test: `android/app/src/test/java/com/innocorelabs/verbale/billing/CapResolutionTest.kt` (new, pure).

- [ ] **Step 1: Extract the cap decision as a pure function and test it first**

Add to `AllowancePolicy` (inside the object):

```kotlin
  /** The captured-audio limit for a new session: none for a paid one, an hour for a Free one. */
  fun capFor(paid: Boolean): Long = if (paid) 0L else FREE_DURATION_MS
```

Create `CapResolutionTest.kt`:

```kotlin
package com.innocorelabs.verbale.billing

import org.junit.Assert.assertEquals
import org.junit.Test

class CapResolutionTest {
  @Test fun `a paid session is uncapped and a free one is capped at an hour`() {
    assertEquals(0L, AllowancePolicy.capFor(true))
    assertEquals(3_600_000L, AllowancePolicy.capFor(false))
  }

  // The tile, the shortcut and the record screen all end in CaptureController.start, which asks
  // this and nothing else — there is no caller-supplied cap any more to forget.
  @Test fun `the cap does not depend on who started the recording`() {
    assertEquals(AllowancePolicy.capFor(false), AllowancePolicy.capFor(false))
  }
}
```

Run `--tests '*CapResolutionTest*'`: first fails to compile (`capFor`), passes after adding it.

- [ ] **Step 2: Change `CaptureController.start`**

Replace the signature and the head of the function:

```kotlin
  /** A Free start was refused: the month's sessions are used up. [resetsOn] is "YYYY-MM-DD". */
  class AllowanceExhausted(val resetsOn: String) : Exception("free allowance used up until $resetsOn")

  /**
   * Create the meeting row, start the foreground capture service. Returns the meetingId, or null.
   * Throws [AllowanceExhausted] when a Free session is not available.
   *
   * The allowance and the length limit are decided HERE, natively, from the licence — not passed in.
   * The Quick Settings tile and the shortcut call this with nothing but a context, and used to
   * record without a limit.
   */
  fun start(context: Context, tier: String = "free", mode: String? = null): String? {
    if (isRecording) return currentMeetingId
    if (stopping) return null
    if (!hasMicPermission(context)) return null
    attach(context)

    val meetingId = UUID.randomUUID().toString()
    val createdAt = System.currentTimeMillis()
    val paid = com.innocorelabs.verbale.billing.LicenceStore.entitled(context)
    val db = AudioDb.get(context)
    val reservation = com.innocorelabs.verbale.billing.Allowance.reserve(
      db.allowanceStore(), meetingId, paid, createdAt, java.util.TimeZone.getDefault(),
    )
    if (reservation is com.innocorelabs.verbale.billing.Allowance.Reservation.Denied) {
      throw AllowanceExhausted(reservation.resetsOn)
    }
    val capMs = com.innocorelabs.verbale.billing.AllowancePolicy.capFor(paid)
```

Keep the body (dir, `insertMeeting`, mode, intent with `EXTRA_CAP_MS`, `startForegroundService`, state, `persist`, `fanOut`) but wrap everything from `val dir = …` to just before `return meetingId` in:

```kotlin
    try {
      ... existing body ...
    } catch (e: Exception) {
      // Nothing started: the slot was never used.
      com.innocorelabs.verbale.billing.Allowance.refund(db.allowanceStore(), meetingId)
      throw e
    }
```

and use the `db` already obtained rather than calling `AudioDb.get(context)` again. Delete the old default-`capMs` parameter; fix every caller (`grep -rn "CaptureController.start(" android/app/src` — `AudioPipelineModule`, `ShimActivity`, and `androidTest/CaptureStateTest.kt` if it passes arguments).

- [ ] **Step 3: `AudioPipelineModule.start`** — delete the `capMs` lines and the comment above them; call `CaptureController.start(ctx, tier, mode)`; add before the generic catch:

```kotlin
    } catch (e: CaptureController.AllowanceExhausted) {
      promise.reject("allowance_exhausted", e.resetsOn)
    } catch (e: Exception) {
```

- [ ] **Step 4: `ShimActivity.quickStart`** — catch the new exception around `CaptureController.start(applicationContext)` and open the app:

```kotlin
    val id = try {
      CaptureController.start(applicationContext)
    } catch (e: CaptureController.AllowanceExhausted) {
      Log.i(TAG, "quick start refused: allowance used up until ${e.resetsOn}; opening the app")
      try {
        startActivity(
          android.content.Intent(this, com.innocorelabs.verbale.MainActivity::class.java)
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      } catch (e2: Exception) {
        Log.w(TAG, "could not open the app", e2)
      }
      null
    } catch (e: Exception) {
```

(The app opens on its normal screen; Part 2 makes that screen say why.)

- [ ] **Step 5: Compile and run everything**

Run: `cd android && ./gradlew :app:compileDebugKotlin :app:testDebugUnitTest -q 2>&1 | tail -20`
Expected: no errors. Also `cd android && ./gradlew :app:compileDebugAndroidTestKotlin -q 2>&1 | tail` so the device tests still compile.

- [ ] **Step 6: Commit**

```bash
git add -A android/app/src
git commit -m "feat(allowance): native start reserves a slot and resolves the cap — the tile can no longer record uncapped"
```

---

### Task 6: One hour, a five-minute warning, enforced to the second

**Files:**
- Modify: `CapClock.kt:18` (`WARN_BEFORE_MS`), `RecordingService.kt` (~L451-478 loop), `src/billing/recordingCap.ts`.
- Test: `CapClockTest.kt`, `src/billing/__tests__/recordingCap.test.ts`.

- [ ] **Step 1: Update the tests first (they pin 15 minutes / 3 minutes)**

`CapClockTest.kt`: set `private val cap = 3_600_000L // 60 minutes`; change expected strings: `"04:12 / 60:00"`, `"11:59 / 60:00"` becomes `"54:59 / 60:00"` for `plus(3_299_999L)`; the warning boundary becomes `3_300_000L` (55:00) with label `"5:00 left on Free"`; the final-minute boundary stays 60 s before the cap. Read the whole file and adjust every number mechanically — each literal derived from `900_000`/`720_000` moves by +45 min/`3_300_000`.

`recordingCap.test.ts`: `FREE_CAP_MS` → `60 * MIN`; `WARN_BEFORE_MS` → `5 * MIN`; `countdown(12 * MIN, …)` → `countdown(55 * MIN, …)` `'5:00'`; `countdown(55 * MIN + 1000, …)` `'4:59'`; `running` cases at `0` and `50 * MIN`; test names say "an hour". Rename "caps a free recording at fifteen minutes" → "caps a free recording at one hour".

Run both; expected: FAIL.

- [ ] **Step 2: Change the constants**

`CapClock.kt`: `const val WARN_BEFORE_MS = 5 * 60_000L`. `recordingCap.ts`: `FREE_CAP_MS = 60 * 60 * 1000`, `WARN_BEFORE_MS = 5 * 60 * 1000`; update the doc comment ("An hour — about one recurring meeting", warning "five minutes", drop "Fifteen minutes. Long enough for a real stand-up").

- [ ] **Step 3: Enforce at the 1-second cadence**

In `RecordingService.kt`, the `cap > 0L && reads % DISK_CHECK_EVERY_READS == 0` block does two jobs. Split it:

```kotlin
            val cap = CaptureController.capMs
            if (cap > 0L && reads % WARN_CHECK_EVERY_READS == 0) {
              val capturedMs = File(path).length() / BYTES_PER_MS
              if (capturedMs >= cap) {
                Log.i(TAG, "free tier limit reached at ${capturedMs}ms — stopping and keeping it")
                endReason = END_CAP_REACHED
                recording = false
              }
            }
            if (cap > 0L && reads % DISK_CHECK_EVERY_READS == 0) {
              val capturedMs = File(path).length() / BYTES_PER_MS
              // (keep the existing comment) In the last five minutes, ask whether Pro has been bought…
              if (CapClock.counting(CapClock.phase(capturedMs, cap)) && LicenceStore.entitled(this@RecordingService)) {
                Log.i(TAG, "entitled at ${capturedMs}ms with ${cap - capturedMs}ms to the free limit — cap lifted")
                CaptureController.capMs = 0L
              }
            }
```

Order matters: the cap check runs at ≈1 s cadence and may stop a recording the half-minute entitlement check had not yet lifted. That is acceptable only because the entitlement poll now starts five minutes out (it ran three before) — leave the comment saying so. Change "last three minutes" in comments to "last five minutes".

- [ ] **Step 4: Run** — `npx jest src/billing -q` and `cd android && ./gradlew :app:testDebugUnitTest -q`. Expected: PASS.

- [ ] **Step 5: Mutation check** — set `WARN_BEFORE_MS` back to 3 min in only one of the two files → each side's test fails; restore.

- [ ] **Step 6: Commit**

```bash
git add -A android/app/src src/billing
git commit -m "feat(allowance): the Free limit is one hour, warned five minutes out, enforced to the second"
```

---

### Task 7: Commit and refund slots when capture ends and when processing ends

**Files:**
- Modify: `RecordingService.kt` (~L631-640, right after `db.setEndReason(...)`), `ProcessingService.kt` (~L109-120, where `outcome == "done"`), and the app-start sweep (find it: `grep -rn "sweep\|Reconcile" android/app/src/main/java/com/innocorelabs/verbale/pipeline/ProcessingService.kt android/app/src/main/java/com/innocorelabs/verbale/MainApplication.kt | head`).
- Test: the pure verdicts are already covered in Tasks 1–2; this task is wiring and is device-verified (Task 9).

- [ ] **Step 1: Capture end** — after `if (bytes == 0L) db.setStatus(id, "error")` add:

```kotlin
        // The slot taken at start: kept once a minute of audio exists, handed back when nothing was
        // captured, and for a shorter one left until processing says whether it was usable.
        db.settleAllowance(id, processingDone = bytes == 0L)
```

- [ ] **Step 2: Processing end** — in `ProcessingService`, where the run finishes for meeting `id` (both `done` and `error` outcomes, i.e. wherever `onComplete` is handled and the status is final), add:

```kotlin
              AudioDb.get(this@ProcessingService).settleAllowance(id, processingDone = true)
```

Do not call it for `cancelled`, or for a crash that will be retried: retries never touch the slot, and only a *final* outcome may refund.

- [ ] **Step 3: Sweep on start** — call `AudioDb.get(ctx).sweepAllowance()` once where the app/service already sweeps orphaned meetings at startup, guarded by `!CaptureController.isRecording`. A reservation abandoned by a dead process settles from the file and transcript on the next launch.

- [ ] **Step 4: Compile + unit tests** — `cd android && ./gradlew :app:compileDebugKotlin :app:testDebugUnitTest -q 2>&1 | tail`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A android/app/src
git commit -m "feat(allowance): capture end and processing end settle the slot; a dead process is swept on launch"
```

---

### Task 8: Imports use the same allowance

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/audio/AudioImport.kt` — `import()` (~L67-105) and `decodeTo` duration check (~L137-147).
- Modify: `ImportModule.kt` `runImport` catch — surface `allowance_exhausted` / `import_too_long`.
- Test: pure helper `AllowancePolicy.importVerdict` in `AllowancePolicyTest`.

- [ ] **Step 1: Failing test** (add to `AllowancePolicyTest`)

```kotlin
  @Test fun `a free import over an hour is refused before it starts, a paid one is not`() {
    assertEquals(AllowancePolicy.Import.OK, AllowancePolicy.importVerdict(paid = false, durationMs = 3_600_000L))
    assertEquals(AllowancePolicy.Import.TOO_LONG, AllowancePolicy.importVerdict(paid = false, durationMs = 3_600_001L))
    assertEquals(AllowancePolicy.Import.OK, AllowancePolicy.importVerdict(paid = true, durationMs = 4 * 3_600_000L))
    // Duration unknown (the container does not say): let it through; the decoded length is
    // re-checked once known (Task 8, step 3).
    assertEquals(AllowancePolicy.Import.OK, AllowancePolicy.importVerdict(paid = false, durationMs = 0L))
  }
```

Expected: FAIL (unresolved). Add to `AllowancePolicy`:

```kotlin
  enum class Import { OK, TOO_LONG }

  fun importVerdict(paid: Boolean, durationMs: Long): Import =
    if (!paid && durationMs > FREE_DURATION_MS) Import.TOO_LONG else Import.OK
```

Run: PASS.

- [ ] **Step 2: Reserve before accepting; refund on any failure**

In `AudioImport.import`, at the top (after the free-space check):

```kotlin
    val meetingId = UUID.randomUUID().toString()
    val paid = com.innocorelabs.verbale.billing.LicenceStore.entitled(ctx)
    val store = AudioDb.get(ctx).allowanceStore()
    val reservation = com.innocorelabs.verbale.billing.Allowance.reserve(
      store, meetingId, paid, System.currentTimeMillis(), java.util.TimeZone.getDefault(),
    )
    if (reservation is com.innocorelabs.verbale.billing.Allowance.Reservation.Denied) {
      throw ImportError("allowance_exhausted:${reservation.resetsOn}")
    }
```

Reuse that `meetingId` further down (delete the later `val meetingId = UUID.randomUUID().toString()`), and wrap the rest of the function in `try { … } catch (e: Throwable) { Allowance.refund(store, meetingId); throw e }`. A rejected or cancelled import therefore never consumes a slot.

- [ ] **Step 3: One-hour refusal before decoding**

Pass `paid` into `decodeTo` and, where `totalMs > MAX_DURATION_MS` is checked, add directly after it:

```kotlin
    if (com.innocorelabs.verbale.billing.AllowancePolicy.importVerdict(paid, totalMs) ==
      com.innocorelabs.verbale.billing.AllowancePolicy.Import.TOO_LONG
    ) {
      extractor.release()
      throw ImportError("import_too_long")
    }
```

After decoding, `bytes / BYTES_PER_MS` is the true length; if `importVerdict(paid, thatMs)` is `TOO_LONG` (a container that lied or gave no duration), delete the temp file and throw the same `ImportError("import_too_long")` — never truncate silently.

- [ ] **Step 4: Commit settle for a good import** — after `db.markCaptured(...)` add `db.settleAllowance(meetingId, processingDone = false)` (an import ≥ 60 s commits at once; a shorter one waits for its transcript).

- [ ] **Step 5: Surface the codes** — in `ImportModule.runImport`, in `catch (e: AudioImport.ImportError)` map `e.message` starting `allowance_exhausted:` → `promise.reject("allowance_exhausted", message.substringAfter(':'))`, `import_too_long` → `promise.reject("import_too_long", "That recording is longer than the 1 hour Free limit")`; everything else unchanged.

- [ ] **Step 6: Compile + test** — `cd android && ./gradlew :app:compileDebugKotlin :app:testDebugUnitTest -q 2>&1 | tail`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A android/app/src
git commit -m "feat(allowance): imports share the allowance and the one-hour limit; rejected imports cost nothing"
```

---

### Task 9: JS stops deciding the cap; the 15-minute copy goes

**Files:**
- Modify: `src/pipeline/PipelineController.ts:136-149`, `src/screens/recordMode.ts:25-29`, `src/screens/RecordScreen.tsx:496-504`, `src/screens/PaywallScreen.tsx:130`.
- Test: `src/screens/__tests__/recordMode.test.ts`, `src/pipeline/__tests__/startRecording.test.ts`.

- [ ] **Step 1: Update tests first**

`recordMode.test.ts`: `idleHint('meeting', 3_600_000)` → `'Tap to start recording · up to 1 hour on Free'`; dictation likewise `'Tap to dictate · up to 1 hour on Free'`.
`startRecording.test.ts`: read it first; any assertion that `AudioPipeline.start` receives `capMs` must now assert the argument has **no** `capMs` key (`expect(arg).not.toHaveProperty('capMs')`), and a new test: when native rejects with `{ code: 'allowance_exhausted', message: '2026-11-01' }`, `startRecording` rejects with an error whose `code` is `allowance_exhausted` (so the screen can tell it from a generic failure).

Run: `npx jest src/screens/__tests__/recordMode.test.ts src/pipeline/__tests__/startRecording.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`PipelineController.startRecording`: remove the `entitlement()` call and `capMs`; update the doc comment (the cap is now resolved natively by `CaptureController.start`, and every entry point shares it):

```ts
    return AudioPipeline.start({ sampleRate: 16000, language, ...(mode ? { mode } : {}) });
```
Remove the now-unused `capMsFor`/`entitlement` imports if nothing else in the file uses them (the linter will say). In `src/native/NativeAudioPipeline.ts` delete the `capMs` field and its doc.

`recordMode.ts`: `up to 15 min on Free` → `up to 1 hour on Free`.
`RecordScreen.tsx` L500-503: `stop at 15 minutes` → `stop at 1 hour`, both strings.
`PaywallScreen.tsx` L130: `Free meetings run up to 15 minutes.` → `Free: 5 meetings each month, up to 1 hour each.`

`RecordScreen`'s `startRecording` failure path: find where the store's `start` errors are shown (`grep -n "start" src/state/recordingStore.ts`) and, for `code === 'allowance_exhausted'`, show: `You've used your 5 free meetings this month. Your saved meetings are still available. Get Pro for more meetings, or record again from <resetsOn formatted "1 November">.` (exact spec copy, §3). Format the date with a small pure helper `formatReset('2026-11-01') → '1 November'` in `src/billing/allowanceCopy.ts` with a test in `src/billing/__tests__/allowanceCopy.test.ts` (inputs `'2026-11-01'`→`'1 November'`, `'2027-01-01'`→`'1 January'`). Part 2 builds the full remaining-meetings UI; this task only makes the refusal honest.

- [ ] **Step 3: Run the JS checks**

Run: `npx jest -q 2>&1 | tail -15 && npm run typecheck 2>&1 | tail && npm run lint 2>&1 | tail`
Expected: all green.

- [ ] **Step 4: Prove nothing else still says 15**

Run: `grep -rnIE "15 ?min|fifteen|900_?000" src android/app/src/main/res docs/store | grep -v "__tests__\|graphify-out\|evidence.test\|minutes.golden"`
Expected: no policy hits. Anything that remains (store listing text, onboarding) is recorded in the commit message for Part 2 — do not hunt beyond this grep.

- [ ] **Step 5: Commit**

```bash
git add -A src android/app/src
git commit -m "feat(allowance): JS no longer decides the cap; one hour and five-a-month copy; honest refusal on the sixth"
```

---

### Task 10: Gate and device verification

- [ ] **Step 1: Run the project gate's cheap stages**

Run: `GATE_STAGES="types js scans kotlin" npm run gate 2>&1 | tail -30`
Expected: every stage passes. `scans` includes the network-egress and prompt-fencing checks; the ledger adds no network and no model prompt, so a failure here is a real finding.

- [ ] **Step 2: Device checklist (target: Galaxy A07 or the Galaxy Tab; follow `docs/superpowers/` device recipes in memory — `pixel-device-testing-recipes`, `galaxy-a07-findings`)**

Write results into a new report `docs/superpowers/reports/2026-10-07-free-allowance-native.md` with a PASS/FAIL line per item, evidence (logcat line / screenshot) for each:

1. Fresh install (or `adb shell pm clear` on a throwaway build — **never wipe the A07's real meeting**): start 5 recordings of ≥ 60 s via the app; the 6th `start` is refused with the exhausted message.
2. Quick Settings tile with allowance used up: the app opens, nothing records (logcat `quick start refused`).
3. Tile with allowance available: records, and logcat shows `capMs=3600000` handed to the service (this is the old hole — it must now be capped).
4. A 3-second tap-and-stop does **not** use a slot (remaining stays at its prior value after processing says no speech).
5. Pause for 2 minutes in a Free recording: capture still stops at 60:00 of audio (use a debug build with `FREE_DURATION_MS` temporarily set to 2 min via a local, uncommitted edit — do **not** commit it — to avoid an hour per run; record the real 60-minute run once, screen-off, on the A07).
6. Notification and PiP: warning from 55:00, final minute red, stop at 60:00, recording saved and transcribed.
7. Kill the app process mid-recording, relaunch: the reservation is settled (not stuck RESERVED): `adb shell run-as … ` is unavailable on a release build — read the ledger through the debug build.
8. Import a 61-minute file as Free: refused before decoding, no slot used. Import a 5-minute file: accepted, one slot.
9. Back up, restore on the same phone: slots unchanged (not doubled).
10. Date roll-back by 1 month on a debug phone with 5 used: still refused.

- [ ] **Step 3: Update memory** — add one line to the project memory index for this work (state, branch, what the device pass found), per the repo's habit.

---

## Self-review (against spec §3 and §4-B)

| Spec requirement | Task |
|---|---|
| 5/month, local calendar reset, no rollover | 1 |
| Reserve atomically before capture/import; commit at ≥ 60 s or usable transcript; refund accidental/cancelled | 2, 5, 7, 8 |
| Pause/retry/crash recovery/regenerate never consume | 2 (idempotent id), 7 (retry never touches slot; sweep) |
| Delete/archive does not restore; backup restore does not recount | 3 (no FK), 4 (`INSERT OR IGNORE`) |
| Crossing midnight into new month charges the start month | 2 (test) |
| 60 minutes of captured audio, pauses excluded, native, within a second | 6 |
| Warn at 5 minutes, final-minute countdown in app/PiP/notification | 6 (shared constant; PiP/notification read `CapClock`) |
| Stop saves audio and queues processing | existing `END_CAP_REACHED` path, unchanged; device item 6 |
| Free import > 60 min explained, not truncated, no slot used | 8 (error codes; copy surfaced in Part 2) |
| Upgrade during capture lifts cap; pending purchase does not | existing entitlement poll, now 5 min out; device item |
| Pro-at-start retains through capture | 5 (`capFor(paid)` at start; expiry only affects next session) |
| Pro sessions do not consume Free slots | 2 (`Unlimited` writes nothing) |
| Clock rollback never grants a second reset | 1 |
| Migration: new period starts with 5; nothing retroactive | 3 (empty table) |
| Replace all 15-minute copy | 9 (grep gate) — store listing and onboarding copy → Part 2 |
| Remaining/reset display, exhausted state UI, free keyword search | **Part 2** |
| Backup/restore preserves saved content after downgrade | unchanged behaviour; no code touches content |
| Quick Settings tile / shortcut uncapped (found while planning) | 5 |

**Known limitation carried from the spec:** reinstall/clear-data resets a local-only ledger; accepted in §3.

**Open decision for the founder (not blocking this plan):** the spec's "reserve before capture, commit at 60 s" means a start-and-stop of under a minute holds its slot until the transcript is judged. If processing never runs (feature disabled / model missing), a sub-minute session stays RESERVED and counts. The launch sweep settles it from the transcript on the next start; a meeting with no transcript is refunded. Confirm that is the intended trade-off before Part 2.
