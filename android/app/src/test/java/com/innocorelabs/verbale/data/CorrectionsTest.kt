package com.innocorelabs.verbale.data

import com.innocorelabs.verbale.data.Corrections.Snapshot
import com.innocorelabs.verbale.data.Corrections.Span
import com.innocorelabs.verbale.pipeline.Minutes
import com.innocorelabs.verbale.pipeline.Reconciler
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * F15: the rules a transcript correction follows, on the JVM. The SQL that applies them is
 * `CorrectionsDbTest` (androidTest, device-only); what is pinned here is every decision.
 */
class CorrectionsTest {

  private fun snap(s: Long, e: Long, v: String = "fixed") = Snapshot(s, e, v)

  // ---- Which new line a correction belongs to ----------------------------------------------

  private data class Case(val name: String, val s: Snapshot, val spans: List<Span>, val expect: String?)

  private val table = listOf(
    Case("exact overlap", snap(1000, 5000), listOf(Span("a", 1000, 5000), Span("b", 5000, 9000)), "a"),
    Case("slightly shifted boundaries", snap(1000, 5000), listOf(Span("a", 1200, 5300)), "a"),
    // Old line 0-10000 split in two: the correction goes to the half that overlaps most; on a tie, the earlier.
    Case("split utterance, equal halves: the earlier half", snap(0, 10000), listOf(Span("a", 0, 5000), Span("b", 5000, 10000)), "a"),
    Case("split utterance, unequal halves: the larger", snap(0, 10000), listOf(Span("a", 0, 3000), Span("b", 3000, 10000)), "b"),
    // Two old lines merged into one: the new line is longer, so the SHORTER range is the old one.
    Case("merged utterances", snap(0, 4000), listOf(Span("m", 0, 8000)), "m"),
    Case("no overlap at all", snap(1000, 2000), listOf(Span("a", 3000, 4000)), null),
    Case("touching ranges share nothing", snap(1000, 2000), listOf(Span("a", 2000, 3000)), null),
    // 1000 shared of a 4000-ms shorter range = 25%.
    Case("below half of the shorter range", snap(0, 4000), listOf(Span("a", 3000, 9000)), null),
    // 2000 shared of a 4000-ms shorter range = exactly 50%: kept.
    Case("exactly half of the shorter range", snap(0, 4000), listOf(Span("a", 2000, 9000)), "a"),
    Case("a zero-length range never matches", snap(1500, 1500), listOf(Span("a", 1000, 2000)), null),
    Case("empty transcript", snap(0, 1000), emptyList(), null),
  )

  @Test fun bestMatchTable() {
    for (c in table) assertEquals(c.name, c.expect, Corrections.bestMatch(c.s, c.spans)?.id)
  }

  @Test fun theGreatestOverlapWinsNotTheFirstLine() {
    val spans = listOf(Span("a", 0, 2500), Span("b", 2500, 6000))
    // 0-6000 shares 2500 with a and 3500 with b.
    assertEquals("b", Corrections.bestMatch(snap(0, 6000), spans)?.id)
  }

  // ---- A whole snapshot set -----------------------------------------------------------------

  @Test fun everyCorrectionIsPlacedAndNoneDropped() {
    val spans = listOf(Span("a", 0, 3000), Span("b", 3000, 6000))
    val r = Corrections.reapply(listOf(snap(0, 3000, "one"), snap(3000, 6000, "two")), spans)
    assertEquals(listOf("a" to "one", "b" to "two"), r.applied)
    assertEquals(0, r.dropped)
  }

  @Test fun aCorrectionWithNoLineLeftIsCountedNotLost() {
    val spans = listOf(Span("a", 0, 3000))
    val r = Corrections.reapply(listOf(snap(0, 3000, "one"), snap(50_000, 53_000, "gone"), snap(60_000, 61_000, "gone too")), spans)
    assertEquals(listOf("a" to "one"), r.applied)
    assertEquals(2, r.dropped)
  }

  @Test fun twoCorrectionsMergedIntoOneLineKeepTheLargerAndCountTheOther() {
    // Old 0-3000 and 3000-4000 both inside the new 0-4000: 3000 ms against 1000 ms.
    val spans = listOf(Span("m", 0, 4000))
    val r = Corrections.reapply(listOf(snap(0, 3000, "big"), snap(3000, 4000, "small")), spans)
    assertEquals(listOf("m" to "big"), r.applied)
    assertEquals(1, r.dropped)
  }

  @Test fun theOrderOfTheSnapshotsDoesNotChangeTheWinner() {
    val spans = listOf(Span("m", 0, 4000))
    val r = Corrections.reapply(listOf(snap(3000, 4000, "small"), snap(0, 3000, "big")), spans)
    assertEquals(listOf("m" to "big"), r.applied)
  }

  @Test fun aLaterLargerCorrectionTakesTheLineFromAnEarlierSmallerOne() {
    val spans = listOf(Span("m", 0, 4000))
    val r = Corrections.reapply(listOf(snap(0, 1000, "small"), snap(1000, 4000, "big")), spans)
    assertEquals(listOf("m" to "big"), r.applied)
    assertEquals(1, r.dropped)
  }

  @Test fun noSnapshotsMeansNothingAppliedNothingDropped() {
    val r = Corrections.reapply(emptyList(), listOf(Span("a", 0, 1000)))
    assertTrue(r.applied.isEmpty())
    assertEquals(0, r.dropped)
  }

  // ---- The two columns ------------------------------------------------------------------------

  @Test fun theFirstRawWordingIsKeptForever() {
    // First correction: raw comes from the line.
    val (t1, r1) = Corrections.writeThrough("we sold it to in over", null, "we sold it to Innova")
    assertEquals("we sold it to Innova", t1)
    assertEquals("we sold it to in over", r1)
    // Second correction: raw is NOT replaced by the first correction.
    val (t2, r2) = Corrections.writeThrough(t1, r1, "we sold it to Innova Labs")
    assertEquals("we sold it to Innova Labs", t2)
    assertEquals("we sold it to in over", r2)
  }

  @Test fun revertingPutsTheRecognisersWordsBack() {
    val (t, r) = Corrections.revert("we sold it to Innova", "we sold it to in over")
    assertEquals("we sold it to in over", t)
    assertNull(r)
  }

  @Test fun revertingALineThatWasNeverCorrectedChangesNothing() {
    assertEquals("as heard" to null, Corrections.revert("as heard", null))
  }

  @Test fun revertingReappliesTheVocabularyThePipelineWouldHave() {
    val restore = { s: String -> s.replace("in over", "Innova") }
    val (t, r) = Corrections.revert("hello Innova Labs team", "sold to in over", restore)
    assertEquals("sold to Innova", t)
    assertEquals("sold to in over", r)
  }

  // ---- The summary, the status, the notice ------------------------------------------------------

  @Test fun onlyAWrittenSummaryThatChangedGoesStale() {
    assertTrue(Corrections.narrationStale(hasWrittenSummary = true, textChanged = true))
    assertFalse(Corrections.narrationStale(hasWrittenSummary = false, textChanged = true))
    assertFalse(Corrections.narrationStale(hasWrittenSummary = true, textChanged = false))
  }

  @Test fun onlyAFinishedMeetingIsRederivedAtOnce() {
    assertTrue(Corrections.rederiveNow("done"))
    for (s in listOf("recording", "captured", "asr", "diarized", "failed", "vad")) {
      assertFalse(s, Corrections.rederiveNow(s))
    }
    assertFalse(Corrections.rederiveNow(null))
  }

  @Test fun theNoticeNamesTheCountAndIsSilentForZero() {
    assertNull(Corrections.droppedNotice(0))
    assertEquals("1 correction couldn't be re-applied", Corrections.droppedNotice(1))
    assertEquals("2 corrections couldn't be re-applied", Corrections.droppedNotice(2))
  }

  @Test fun theKeysArePerMeeting() {
    assertEquals("narration.stale.m1", Corrections.narrationStaleKey("m1"))
    assertEquals("corrections.dropped.m1", Corrections.droppedKey("m1"))
    assertEquals("rederive.pending.m1", Corrections.rederivePendingKey("m1"))
  }

  // ---- What the rederive does to items: the real Reconciler over hand-built rows ----------------

  private val LONG_AGO = 1_772_000_000_000L

  private fun stored(id: String, text: String, start: Long, end: Long, touched: Boolean = false, gen: String = "rules@1") =
    AudioDb.StoredItem(
      id, "action", text, "suggested", gen, start, end,
      if (gen == "user") emptyList() else listOf(AudioDb.StoredSource(start, end, 0, text.length, "u1")),
      LONG_AGO, touched,
    )

  private fun incoming(text: String, start: Long, end: Long) =
    Minutes.Item("action", text, listOf(Minutes.Source("u1", start, end, 0, text.length)), start, end)

  @Test fun aCorrectedLineChangesTheActionAndItsTickStaysOnTheSameItem() {
    // The recogniser heard "Meera"; the person corrected it to "Mira", so the extractor now says so.
    val plan = Reconciler.reconcile(
      listOf(stored("item-1", "Send the signed contract to Meera by Friday — Unassigned", 61_000, 64_000, touched = true)),
      listOf(incoming("Send the signed contract to Mira by Friday — Unassigned", 61_000, 64_000)),
    )
    assertEquals(1, plan.rows.size)
    val row = plan.rows.single()
    assertEquals("the same item id, which is what the tick hangs off", "item-1", row.id)
    assertEquals("Send the signed contract to Mira by Friday — Unassigned", row.item.text)
  }

  @Test fun aHandTypedItemSurvivesARederive() {
    val plan = Reconciler.reconcile(
      listOf(
        stored("item-1", "Send the report — Unassigned", 5000, 9000),
        stored("mine", "Book the venue — Unassigned", Long.MIN_VALUE, Long.MIN_VALUE, touched = true, gen = "user"),
      ),
      listOf(incoming("Send the final report — Unassigned", 5000, 9000)),
    )
    val mine = plan.rows.firstOrNull { it.id == "mine" }
    assertNotNull(mine)
    assertEquals("Book the venue — Unassigned", mine!!.item.text)
    assertEquals("user", mine.genVersion)
  }

  @Test fun aTickedItemWhoseLineWasRewrittenBeyondRecognitionIsKeptNotDropped() {
    val plan = Reconciler.reconcile(
      listOf(stored("item-1", "Send the report — Unassigned", 5000, 9000, touched = true)),
      listOf(incoming("Book the venue — Unassigned", 5000, 9000)),
    )
    assertTrue(plan.rows.any { it.id == "item-1" })
  }
}
