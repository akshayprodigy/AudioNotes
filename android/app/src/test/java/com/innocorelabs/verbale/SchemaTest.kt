package com.innocorelabs.verbale

import com.innocorelabs.verbale.data.AudioDb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SchemaTest {
  private val schema = AudioDb.schemaForTest().joinToString("\n")

  /**
   * The single `CREATE TABLE IF NOT EXISTS <table>(...)` statement for `table`, not the joined
   * schema. Each entry in schemaForTest() is already one whole statement, so this scopes a
   * column check to its own table — a plain substring match against the joined schema would let
   * `text` or `meeting_id` pass because a NEIGHBOURING table has that column, which is a test
   * that cannot fail on the thing it claims to check.
   */
  private fun ddlFor(table: String): String =
    AudioDb.schemaForTest().first { it.startsWith("CREATE TABLE IF NOT EXISTS $table(") }

  /**
   * Column names declared in a CREATE TABLE statement. Splits on top-level commas only — depth
   * tracked through parentheses — so `REFERENCES meetings(id)` and a table-level
   * `PRIMARY KEY (a, b)` do not get mistaken for column separators, and a table-level constraint
   * clause is dropped rather than misread as a column. Deliberately NOT one-column-per-line: an
   * added column that lands on an existing line (`item_id TEXT NOT NULL, item_key TEXT NOT NULL,`)
   * is exactly the kind of change this must still catch.
   */
  private fun columnsOf(ddl: String): List<String> {
    val body = ddl.substringAfter('(').let { it.substring(0, it.lastIndexOf(')')) }
    val parts = mutableListOf<String>()
    val current = StringBuilder()
    var depth = 0
    for (c in body) {
      when {
        c == '(' -> { depth++; current.append(c) }
        c == ')' -> { depth--; current.append(c) }
        c == ',' && depth == 0 -> { parts.add(current.toString()); current.clear() }
        else -> current.append(c)
      }
    }
    if (current.isNotBlank()) parts.add(current.toString())
    return parts
      .map { it.trim() }
      .filter {
        it.isNotEmpty() && !it.startsWith("PRIMARY KEY") && !it.startsWith("FOREIGN KEY") &&
          !it.startsWith("UNIQUE") && !it.startsWith("CHECK") && !it.startsWith("CONSTRAINT")
      }
      .map { it.substringBefore(' ') }
  }

  @Test fun itemsTableExists() = assertTrue(schema.contains("CREATE TABLE IF NOT EXISTS items"))
  @Test fun itemSourcesTableExists() =
    assertTrue(schema.contains("CREATE TABLE IF NOT EXISTS item_sources"))
  @Test fun itemDoneTableExists() =
    assertTrue(schema.contains("CREATE TABLE IF NOT EXISTS item_done"))

  /**
   * All fourteen columns, including the five Phase B leaves NULL (item_type, status, owner_json,
   * date_said, date_norm). Those five exist specifically so the classifier lands as a write
   * rather than a migration — nothing else would notice if one were quietly dropped, since no
   * code reads them yet.
   */
  @Test fun itemsHasExpectedColumns() {
    val expected = listOf(
      "id", "meeting_id", "kind", "item_type", "status", "text", "owner_json",
      "date_said", "date_norm", "review", "gen_version", "anchor_start_ms",
      "anchor_end_ms", "created_at",
    )
    val actual = columnsOf(ddlFor("items"))
    assertTrue("missing: ${expected - actual.toSet()}", actual.containsAll(expected))
    assertEquals("column count (extra or missing column)", expected.size, actual.size)
  }

  /**
   * start_ms/end_ms/char_start/char_end are the anchor and the identity; utterance_id and
   * ordinal ride along. Losing any of the four offset columns would silently degrade the
   * evidence to utterance-id-only, which is exactly the identity that does not survive a re-ASR.
   */
  @Test fun itemSourcesHasExpectedColumns() {
    val expected = listOf(
      "item_id", "ordinal", "start_ms", "end_ms", "char_start", "char_end", "utterance_id",
    )
    val actual = columnsOf(ddlFor("item_sources"))
    assertTrue("missing: ${expected - actual.toSet()}", actual.containsAll(expected))
    assertEquals("column count (extra or missing column)", expected.size, actual.size)
  }

  @Test fun itemDoneHasExpectedColumns() {
    val expected = listOf("meeting_id", "item_id", "done_at")
    val actual = columnsOf(ddlFor("item_done"))
    assertTrue("missing: ${expected - actual.toSet()}", actual.containsAll(expected))
    assertEquals("column count (extra or missing column)", expected.size, actual.size)
  }

  /**
   * item_done exists to replace action_done's item_key (a hash of the item's text) with a
   * stable id, because re-recognising a single word changes the hash and silently unticks a
   * confirmed item. item_done sits right next to action_done in the file and is otherwise
   * near-identical in shape, which is exactly the condition under which a column gets
   * copy-pasted back in without anyone noticing. This pins the one design decision the table
   * exists for, not a spelling.
   */
  @Test fun itemDoneDoesNotReintroduceTextHashKeying() =
    assertFalse(columnsOf(ddlFor("item_done")).contains("item_key"))

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
