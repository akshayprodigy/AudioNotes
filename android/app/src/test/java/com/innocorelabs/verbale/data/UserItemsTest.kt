package com.innocorelabs.verbale.data

import com.innocorelabs.verbale.pipeline.Minutes
import com.innocorelabs.verbale.pipeline.Reconciler
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
   * A row stored at the sentinel cannot be MATCHED, even with rule 1 out of the way.
   *
   * Rule 1 is what stops a hand-typed row reaching `Reconciler`'s matching at all, and it is meant
   * to be the only thing doing that work — so this asks what happens if it were ever deleted. The
   * row is labelled `rules@1` here precisely to get past rule 1 and reach rule 2's arithmetic:
   * `min(oldEnd, newEnd) - max(oldStart, newStart)`, kept only when it clears `MIN_OVERLAP_MS`.
   * With the sentinel that lands far below the threshold and, importantly, does not WRAP — a
   * subtraction that underflowed would come back hugely positive and the row would match
   * everything, which is the one failure a value this large could plausibly have.
   *
   * A PREVIOUS VERSION OF THIS TEST CLAIMED `0` "fails the other way", and that is false. It
   * asserted `overlap < 0`, which is the only reason `0` appeared to fail it. `MIN_OVERLAP_MS` is
   * 1, so a row stored at `0..0` yields `-newStart`, which is at most 0 and therefore also never
   * clears the threshold — the plan's own Task 7 note says so. The second half of this test is
   * that correction, asserted rather than written in a comment: both values are inert here, the
   * case for the sentinel over `0` is ORDERING and BRIDGE REPRESENTABILITY, and it does not need a
   * third leg that does not exist.
   *
   * Driven through `Reconciler.reconcile` rather than by re-deriving the subtraction, because the
   * threshold is `Reconciler`'s private business and a test that copies a private constant is a
   * test of its own copy. ReconcilerTest deliberately gives its user row a REAL anchor so that
   * rule 1 stays pinned as a `gen_version` rule rather than as an accident of this constant.
   */
  @Test fun neitherTheSentinelNorZeroCanEverBeMatched() {
    fun matchedIdOf(anchorStart: Long, anchorEnd: Long): String {
      val stored = AudioDb.StoredItem(
        "id-1", "action", "Send the report — Unassigned", AudioDb.Review.SUGGESTED,
        // NOT Gen.USER: rule 1 would set the row aside before the arithmetic below is reached, and
        // the arithmetic is the whole subject of this test.
        Minutes.RULES_GEN, anchorStart, anchorEnd, emptyList(), 1_772_000_000_000L, true,
      )
      val incoming = Minutes.Item(
        "action", "Send the report — Unassigned",
        listOf(Minutes.Source("u-new", 0L, 4_000L, 0, 5)), 0L, 4_000L,
      )
      val plan = Reconciler.reconcile(listOf(stored), listOf(incoming))
      // A match REUSES the stored id; a miss mints a fresh one and preserves the old row beside it.
      return plan.rows.first { it.item.anchorStartMs == 0L }.id
    }

    assertNotEquals(
      "the sentinel anchor wrapped and matched an item said at the start of the meeting",
      "id-1", matchedIdOf(AudioDb.Gen.NO_ANCHOR, AudioDb.Gen.NO_ANCHOR),
    )
    assertNotEquals(
      "0 was supposed to be the dangerous choice and is not — fix the claim, not the code",
      "id-1", matchedIdOf(0L, 0L),
    )
    // And the helper can tell a match from a miss. Without this the two assertions above pass
    // against a `matchedIdOf` that could never return "id-1" at all — a test of its own plumbing,
    // which is the single-row failure this branch keeps finding, wearing a different hat.
    assertEquals(
      "the same row at an anchor that really overlaps did not match, so the misses prove nothing",
      "id-1", matchedIdOf(0L, 4_000L),
    )
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
