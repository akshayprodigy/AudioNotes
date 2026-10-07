package com.innocorelabs.verbale.data

import com.innocorelabs.verbale.billing.AllowancePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The SQL itself needs a real SQLCipher database, so it is device-verified; what a JVM can pin is
 * which tables take which statement and that the ledger's priorities come from AllowancePolicy.
 */
class BackupManagerTest {
  @Test fun `the allowance ledger travels in a backup`() {
    assertTrue("allowance" in BackupManager.tablesForTest())
  }

  @Test fun `every other table still replaces`() {
    for (t in BackupManager.tablesForTest().filter { it != "allowance" }) {
      assertEquals(
        "INSERT OR REPLACE INTO main.$t(a,b) SELECT a,b FROM bak.$t",
        BackupManager.restoreSql(t, "a,b"),
      )
    }
  }

  @Test fun `the ledger upserts by id and keeps the state that uses more allowance`() {
    val sql = BackupManager.restoreSql("allowance", "id,period,state,reserved_at")
    assertTrue(sql, sql.startsWith("INSERT INTO main.allowance(id,period,state,reserved_at) SELECT id,period,state,reserved_at FROM bak.allowance WHERE true ON CONFLICT(id) DO UPDATE SET state = CASE WHEN "))
    assertFalse("REPLACE would let an older backup undo a spent slot", sql.contains("OR REPLACE"))
    assertFalse("the stored period is never rewritten", sql.contains("period ="))
    // The incoming row wins only when it ranks strictly higher.
    assertTrue(sql, sql.contains("(CASE excluded.state ") && sql.contains(") > (CASE allowance.state "))
    assertTrue(sql, sql.endsWith("THEN excluded.state ELSE allowance.state END"))
  }

  @Test fun `the SQL priorities are the policy's priorities`() {
    val expr = BackupManager.statePriority("x")
    for (s in AllowancePolicy.State.values()) {
      assertTrue(expr, expr.contains("WHEN '${s.name}' THEN ${AllowancePolicy.priority(s)}"))
    }
    assertTrue(expr, expr.endsWith("ELSE 0 END)"))
  }
}
