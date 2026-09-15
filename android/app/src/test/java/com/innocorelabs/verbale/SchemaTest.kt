package com.innocorelabs.verbale

import com.innocorelabs.verbale.data.AudioDb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A JVM unit test cannot open a real SQLite database, so this is a SMOKE check on the DDL text
 * only — it can prove a column name is present or absent, because columnsOf tracks all four of
 * SQLite's quoting forms ('...', "...", `...` and [...]), so a paren or comma inside any of them
 * does not desynchronise the parser. It cannot prove the DDL actually parses, and it does not see
 * types, NOT NULL, defaults, foreign keys or index column lists. The AUTHORITATIVE structural
 * assertions — types, the `review` default, FK delete actions, index column order, and whether
 * item_done omits its FK on purpose — live in src/db/__tests__/schema.test.ts, which executes the
 * real DDL from src/db/schema.ts in node:sqlite and reads it back with PRAGMA table_info /
 * foreign_key_list / index_list.
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
   * tracked through parentheses, and parens/commas INSIDE any of SQLite's FOUR quoted-literal
   * forms do not count, so `DEFAULT '('`, `DEFAULT "("`, `` DEFAULT `(` `` and `DEFAULT [(]` all
   * fail to desynchronise the depth counter and swallow every column after them. (The `'('` case
   * — `done_at INTEGER NOT NULL DEFAULT '(', item_key TEXT NOT NULL,` reporting only `done_at`
   * — was a real false pass here, found by mutation-testing this parser, not by inspection; the
   * other three quoting forms were a second false pass found the same way.) `'` , `"` and `` ` ``
   * escape by doubling (`''`, `""`, ` `` `) exactly as SQLite parses them; `[...]` has no escape
   * and simply ends at the first `]`. `REFERENCES meetings(id)` and a table-level
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
    var quote: Char? = null // '\'', '"' or '`' while inside that quoted span; doubling escapes it
    var inBracket = false // SQLite's fourth quoting form, [...]; no escape, ends at the first ']'
    var i = 0
    while (i < body.length) {
      val c = body[i]
      when {
        inBracket -> {
          current.append(c)
          if (c == ']') inBracket = false
        }
        quote != null -> {
          current.append(c)
          if (c == quote) {
            if (i + 1 < body.length && body[i + 1] == quote) {
              // A doubled quote char is an escaped quote inside the literal, not its end.
              current.append(body[i + 1])
              i++
            } else {
              quote = null
            }
          }
        }
        c == '\'' || c == '"' || c == '`' -> { quote = c; current.append(c) }
        c == '[' -> { inBracket = true; current.append(c) }
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

  // Marks: a moment tapped while recording, keyed on the capture clock so a reprocess cannot lose
  // it. Both mirrors carry it; src/db/__tests__/schema.test.ts pins the same four columns.
  @Test fun marksTableExists() = assertTrue(schema.contains("CREATE TABLE IF NOT EXISTS marks"))
  @Test fun marksHasExpectedColumnsAndCascades() {
    val ddl = schema.substringAfter("CREATE TABLE IF NOT EXISTS marks").substringBefore(";")
    for (col in listOf("id", "meeting_id", "at_ms", "created_at")) assertTrue(col, ddl.contains(col))
    assertTrue("cascade", ddl.contains("ON DELETE CASCADE"))
  }
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
   * The migration marker reaches an existing install through ADDED_COLUMNS, or through nothing.
   *
   * `meetings` exists on every phone that has ever opened this app, so `CREATE TABLE IF NOT EXISTS`
   * has nothing to say about it and a column declared only in SCHEMA lands on fresh installs alone
   * — which is the exact population that does NOT need it. Every query naming `items_migrated_at`
   * would then fail on precisely the libraries the sweep exists for.
   *
   * INTEGER, and nullable by omission: NULL means "the rules have never been run over this
   * meeting's transcript", and it is the value every existing row starts with. A DEFAULT would
   * stamp the whole library as already migrated on the ALTER.
   */
  @Test fun theItemsMigrationMarkerIsAnAddedColumn() =
    assertTrue(
      "items_migrated_at is missing from ADDED_COLUMNS: no phone that already has a database " +
        "would gain the column, and unmigratedMeetings names it in its WHERE clause",
      AudioDb.addedColumnsForTest().contains(Triple("meetings", "items_migrated_at", "INTEGER")),
    )

  /**
   * The `meetings` table a real device has, asserted on THIS side of the mirror.
   *
   * src/db/__tests__/schema.test.ts asserts the same eighteen names by executing src/db/schema.ts
   * in node:sqlite. That test can only catch ONE of the two directions: schema.ts losing a column
   * fails it, and AudioDb GAINING one while schema.ts is left alone fails nothing — which is the
   * direction that actually went wrong. `title_edited_at` was in this file and missing from
   * schema.ts for four months, with a docstring in each saying "change both" and nothing checking.
   * Two literal lists, one per language, each failing when its own side moves, is what makes the
   * pair enforceable; a single list read across the boundary is not available, because no test in
   * this repo can see both languages at once.
   *
   * THE UNION, not the CREATE TABLE. `addMissingColumns` runs immediately after `SCHEMA` on every
   * open, so the table a query actually meets is the CREATE TABLE plus every `("meetings", ...)`
   * entry in ADDED_COLUMNS — and the two overlap by three, because a column added after a release
   * is also inlined into the CREATE TABLE for fresh installs. Comparing either half alone would
   * assert a table that exists on no device.
   */
  @Test fun meetingsHasTheSameEighteenColumnsAsTheJavaScriptMirror() {
    val expected = listOf(
      "id", "title", "created_at", "duration_ms", "language", "status", "tier_used",
      "audio_path", "audio_retained", "archived_at", "summary_line", "title_edited_at",
      "transcribe_forced_at", "forced_from_language", "announced_at", "announced_lag_ms",
      "diar_skipped_reason",
      "items_migrated_at",
    )
    val actual = (
      columnsOf(ddlFor("meetings")) +
        AudioDb.addedColumnsForTest().filter { it.first == "meetings" }.map { it.second }
      ).distinct()
    assertEquals(
      "the meetings table AudioDb builds no longer matches the one src/db/schema.ts declares. " +
        "Add or remove the column THERE too (and in its column list in " +
        "src/db/__tests__/schema.test.ts), or the readable copy is describing a table no device " +
        "has — which is how title_edited_at went missing",
      expected.sorted(), actual.sorted(),
    )
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
