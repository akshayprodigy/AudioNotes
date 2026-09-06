package com.innocorelabs.verbale.data

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The ledger behind the privacy screen, checked without a device.
 *
 * The screen's whole claim is that it counts every byte that leaves. A table that only exists on
 * fresh installs would make it count every byte on a NEW phone and silently nothing on an
 * upgraded one — which is the quiet-undercount failure the spec calls out by name.
 */
class NetworkLedgerTest {

  @Test
  fun the_ledger_table_is_declared_in_the_schema() {
    val sql = AudioDb.schemaForTest().joinToString("\n")
    assertTrue(
      "network_events must be created",
      sql.contains("CREATE TABLE IF NOT EXISTS network_events"),
    )
  }

  @Test
  fun the_ledger_records_what_the_screen_has_to_show() {
    val sql = AudioDb.schemaForTest().first { it.contains("network_events") }
    for (column in listOf("at", "kind", "host", "sent", "received", "detail")) {
      assertTrue("network_events needs $column", sql.contains(column))
    }
  }
}
