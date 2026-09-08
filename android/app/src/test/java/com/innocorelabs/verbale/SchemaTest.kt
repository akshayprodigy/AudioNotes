package com.innocorelabs.verbale

import com.innocorelabs.verbale.data.AudioDb
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SchemaTest {
  private val schema = AudioDb.schemaForTest().joinToString("\n")

  @Test fun itemsTableExists() = assertTrue(schema.contains("CREATE TABLE IF NOT EXISTS items"))
  @Test fun itemSourcesTableExists() =
    assertTrue(schema.contains("CREATE TABLE IF NOT EXISTS item_sources"))
  @Test fun itemDoneTableExists() =
    assertTrue(schema.contains("CREATE TABLE IF NOT EXISTS item_done"))

  /**
   * New TABLES belong in SCHEMA and nowhere else. ADDED_COLUMNS exists because CREATE TABLE IF NOT
   * EXISTS is a no-op against a table that already exists — it has nothing to say about a table
   * that does not, which is created normally on every open including on an upgraded install.
   */
  @Test fun newTablesAreNotInAddedColumns() {
    val tables = AudioDb.addedColumnsForTest().map { it.first }
    assertFalse(tables.contains("items"))
    assertFalse(tables.contains("item_sources"))
    assertFalse(tables.contains("item_done"))
  }

  @Test fun theAnchorIsIndexed() =
    assertTrue(schema.contains("idx_item_sources_start"))

  /** Not in the plan's listing of tests, added to match its own SCHEMA listing: idx_items_meeting
   * is the index a meeting-scoped items query (every caller in Task 6+) actually uses. */
  @Test fun theItemsAnchorIsIndexed() =
    assertTrue(schema.contains("idx_items_meeting"))
}
