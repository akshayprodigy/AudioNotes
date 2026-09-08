package com.innocorelabs.verbale

import com.innocorelabs.verbale.data.AudioDb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A JVM unit test cannot open a real SQLite database, so this is a SMOKE check on the DDL text
 * only — it can prove a column name is present or absent, but it cannot prove the DDL actually
 * parses, and it does not see types, NOT NULL, defaults, foreign keys or index column lists. The
 * AUTHORITATIVE structural assertions — including whether item_done omits its FK on purpose and
 * whether char_start/char_end are really NOT NULL — live in src/db/__tests__/schema.test.ts,
 * which executes the real DDL from src/db/schema.ts in node:sqlite and reads it back with
 * PRAGMA table_info / foreign_key_list / index_list.
 */
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
   * tracked through parentheses, and parens/commas INSIDE a single-quoted string literal do not
   * count, so `DEFAULT '('` does not desynchronise the depth counter and swallow every column
   * after it. (That exact case — `done_at INTEGER NOT NULL DEFAULT '(', item_key TEXT NOT
   * NULL,` reporting only `done_at` — was a real false pass here, found by mutation-testing
   * this parser, not by inspection.) `REFERENCES meetings(id)` and a table-level
   * `PRIMARY KEY (a, b)` do not get mistaken for column separators either, and a table-level
   * constraint clause is dropped rather than misread as a column. Deliberately NOT
   * one-column-per-line: an added column that lands on an existing line
   * (`item_id TEXT NOT NULL, item_key TEXT NOT NULL,`) is exactly the kind of change this must
   * still catch.
   *
   * What this still cannot catch: a trailing comma before the closing paren, which is invalid
   * SQLite DDL and would stop the app opening its database on every device. Only real SQLite
   * execution proves the statement parses — see schema.test.ts.
   */
  private fun columnsOf(ddl: String): List<String> {
    val body = ddl.substringAfter('(').let { it.substring(0, it.lastIndexOf(')')) }
    val parts = mutableListOf<String>()
    val current = StringBuilder()
    var depth = 0
    var inQuote = false
    var i = 0
    while (i < body.length) {
      val c = body[i]
      when {
        inQuote -> {
          current.append(c)
          if (c == '\'') {
            if (i + 1 < body.length && body[i + 1] == '\'') {
              // '' is an escaped quote inside the literal, not its end.
              current.append(body[i + 1])
              i++
            } else {
              inQuote = false
            }
          }
        }
        c == '\'' -> { inQuote = true; current.append(c) }
        c == '(' -> { depth++; current.append(c) }
        c == ')' -> { depth--; current.append(c) }
        c == ',' && depth == 0 -> { parts.add(current.toString()); current.clear() }
        else -> current.append(c)
      }
      i++
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

  /**
   * idx_items_meeting is the index a meeting-scoped items query (every caller in Task 6+)
   * actually uses. item_sources has no equivalent index: every read is
   * `WHERE item_id IN (...) ORDER BY item_id, ordinal`, already served by the composite
   * PRIMARY KEY's autoindex, so an idx_item_sources_start would be pure write amplification on
   * every source row of every reprocess with no reader anywhere in Tasks 6-13. Adding one later
   * is cheap — CREATE INDEX IF NOT EXISTS runs on every open, not just fresh installs — so it is
   * deliberately absent rather than spent speculatively.
   */
  @Test fun theItemsAnchorIsIndexed() =
    assertTrue(schema.contains("idx_items_meeting"))
}
