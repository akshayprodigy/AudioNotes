package com.innocorelabs.verbale.data

import com.innocorelabs.verbale.pipeline.Minutes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two constants a hand-typed item rests on, pinned on the Kotlin side of the bridge.
 *
 * THESE ARE CROSS-LANGUAGE CONTRACTS, NOT TIDY CONSTANTS, which is what makes asserting a literal
 * worth doing. Both values are WRITTEN by JavaScript — `db.addUserItem` in src/db/queries.ts — and
 * READ here: `Reconciler` rule 1 refuses to match, replace or flag a row carrying
 * [AudioDb.Gen.USER], so a person's own item is never swallowed by an extracted one;
 * `AudioDb.indexItems` decides where a search hit on one opens the meeting;
 * `FileExportModule.exportItems` decides whether it is stamped with a moment.
 *
 * The two spellings meet only inside the database. Change one side and nothing fails to compile,
 * nothing throws, and no test anywhere else goes red: hand-typed items simply stop being
 * recognised as hand-typed, lose rule 1's protection, and are deleted by rule 4 on the first
 * reprocess — because the rules will never extract a sentence nobody said. That is the same class
 * of silent divergence `ItemKeyTest` exists for, and this is the same instrument: the literal,
 * asserted on both sides, in tests that name each other. The JavaScript half is
 * src/db/__tests__/userItems.test.ts.
 */
class UserItemsTest {

  /**
   * The gen a person's own item carries, spelled out.
   *
   * Unversioned on purpose, and the `else` branch in `db.allActions` is why: it reports anything
   * that is not exactly this string as `rule`, so a `user@1` — the convention `rules@1` sets for
   * the other half of this vocabulary — would reclassify every hand-typed action in the worklist
   * the day somebody added it.
   */
  @Test fun theUserGenIsSpelledTheWayJavaScriptWritesIt() {
    assertEquals("user", AudioDb.Gen.USER)
  }

  /** And it is not the rules' gen, which is the one thing it must never be mistaken for. */
  @Test fun theUserGenIsNotTheRulesGen() {
    assertNotEquals(Minutes.RULES_GEN, AudioDb.Gen.USER)
  }

  /**
   * The sentinel anchor is `Number.MAX_SAFE_INTEGER`, and that exact value is the point.
   *
   * Every query parameter crosses the bridge as JSON and `StorageModule.parseArgs` binds it as
   * text, so a sentinel above 2^53 arrives ROUNDED: `Long.MAX_VALUE` becomes 9223372036854775808,
   * which is not a valid INT64 and which SQLite therefore stores as a REAL in an INTEGER column —
   * after which the ordering this constant exists for is a floating-point comparison and the value
   * read back is not the value written. The round trip through a Double is what JSON does, so
   * asserting it survives one is the assertion, not `assertEquals` to a literal.
   */
  @Test fun theSentinelAnchorSurvivesTheJsonBridgeExactly() {
    assertEquals(9_007_199_254_740_991L, AudioDb.Gen.NO_ANCHOR)
    assertEquals(AudioDb.Gen.NO_ANCHOR, AudioDb.Gen.NO_ANCHOR.toDouble().toLong())
  }

  /**
   * And it sorts after anything that could ever be a real moment.
   *
   * Every read of `items` is `ORDER BY anchor_start_ms, rowid`, so this value is what keeps a
   * hand-typed row LAST — where it has always been, because it lived in `minutes` and was appended
   * after the items. A hundred years of continuous recording is the vector rather than a round
   * number, because the failure it guards against is a long recording, not an arithmetic one.
   */
  @Test fun theSentinelAnchorSortsAfterEveryRealMoment() {
    val aCenturyOfRecordingMs = 100L * 365 * 24 * 60 * 60 * 1000
    assertTrue(AudioDb.Gen.NO_ANCHOR > aCenturyOfRecordingMs)
  }

  /**
   * A hand-typed row cannot overlap anything, which is the fail-safe direction.
   *
   * `Reconciler` rule 2 computes `min(oldEnd, newEnd) - max(oldStart, newStart)` and keeps the pair
   * only when that clears `MIN_OVERLAP_MS`. Rule 1 is what stops a typed row reaching that
   * arithmetic at all — and if it were ever deleted, this value makes the overlap hugely negative
   * rather than overflowing, so the row matches NOTHING instead of matching whatever the meeting
   * happens to open with. `0`, the value this task's listing proposed, fails the other way.
   *
   * The subtraction is written out here because "it cannot underflow" is a claim about Long
   * arithmetic and not about intent: `end - NO_ANCHOR` for any non-negative `end` lands in
   * [-NO_ANCHOR, 0], well inside Long.
   */
  @Test fun theSentinelAnchorMakesAnOverlapImpossibleRatherThanCertain() {
    val incomingStart = 0L
    val incomingEnd = 4_000L
    val overlap = minOf(incomingEnd, AudioDb.Gen.NO_ANCHOR) -
      maxOf(incomingStart, AudioDb.Gen.NO_ANCHOR)
    assertTrue("a hand-typed row was made to overlap the start of the meeting", overlap < 0)
  }

  /**
   * The column is still NOT NULL, which is the entire reason a sentinel exists.
   *
   * If somebody ever rebuilds `items` to make `anchor_start_ms` nullable, the sentinel and every
   * derivation that turns it back into "no moment" become dead weight — and this is the test that
   * points at them, rather than leaving a value nobody can explain. SchemaTest's parser is the
   * precedent for reading the DDL as text on the JVM; the authoritative structural assertions live
   * in src/db/__tests__/schema.test.ts, which executes it.
   */
  @Test fun theAnchorColumnIsStillNotNullWhichIsWhyTheSentinelExists() {
    val items = AudioDb.schemaForTest().first { it.startsWith("CREATE TABLE IF NOT EXISTS items(") }
    assertTrue(
      "anchor_start_ms is nullable now — the sentinel and its derivations can go",
      items.contains("anchor_start_ms INTEGER NOT NULL"),
    )
    assertTrue(items.contains("anchor_end_ms INTEGER NOT NULL"))
  }
}
