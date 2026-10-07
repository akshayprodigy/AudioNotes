package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * F25, the relevance floor on meaning hits. The defects it guards: a weak meaning hit shown as a
 * "≈" row (A07: "pricing" listed "≈ Book the demo room for Friday"), the floor applied after
 * fusion where `score` is no longer a cosine, keyword hits losing rows to a cosine threshold, and
 * Ask's retrieval silently inheriting a floor that was measured on search queries only.
 */
class RetrieverFloorTest {
  private val floor = Retriever.MEANING_MIN_SIMILARITY

  private fun meaning(id: String, cos: Double, meeting: String = "m1") =
    Retriever.Hit(meeting, "utterance", id, 0, 0, "text $id", cos, byMeaning = true)

  private fun keyword(id: String, bm25: Double = -3.2, meeting: String = "m1") =
    Retriever.Hit(meeting, "utterance", id, 0, 0, "text $id", bm25, byMeaning = false)

  @Test fun theFloorIsTheMeasuredValue() {
    // docs/superpowers/reports/2026-10-07-f25-search-floor.md; changing it means re-measuring.
    assertEquals(0.60, Retriever.MEANING_MIN_SIMILARITY, 0.0)
  }

  @Test fun aHitBelowTheFloorIsDropped() {
    val out = Retriever.aboveFloor(listOf(meaning("a", floor - 1e-6)), floor)
    assertTrue(out.isEmpty())
  }

  @Test fun aHitExactlyAtTheFloorIsKept() {
    val out = Retriever.aboveFloor(listOf(meaning("a", floor)), floor)
    assertEquals(listOf("a"), out.map { it.refId })
  }

  @Test fun theOrderOfTheSurvivorsIsKept() {
    val list = listOf(meaning("a", .75), meaning("b", .50), meaning("c", .70), meaning("d", .61), meaning("e", .59))
    assertEquals(listOf("a", "c", "d"), Retriever.aboveFloor(list, floor).map { it.refId })
  }

  @Test fun anEmptyResultIsFine() {
    assertTrue(Retriever.aboveFloor(emptyList(), floor).isEmpty())
    assertTrue(Retriever.search(emptyList(), emptyList(), floor).isEmpty())
    assertTrue(Retriever.search(emptyList(), listOf(meaning("a", .3), meaning("b", .5)), floor).isEmpty())
  }

  @Test fun keywordHitsAreNeverFilteredByTheFloor() {
    // bm25 scores are small or negative numbers; they are not cosines and the floor must not see them.
    val kw = listOf(keyword("a", -4.0), keyword("b", 0.0), keyword("c", 0.2))
    val out = Retriever.search(kw, emptyList(), floor)
    assertEquals(listOf("a", "b", "c"), out.map { it.refId })
    assertTrue(out.none { it.byMeaning })
  }

  @Test fun whenEveryMeaningHitIsBelowTheFloorTheResultIsKeywordOnlyWithNoApproximateRows() {
    val kw = listOf(keyword("k1"), keyword("k2"))
    val weak = (1..40).map { meaning("w$it", .40 + it / 1000.0) }   // 0.401 .. 0.44
    val out = Retriever.search(kw, weak, floor)
    assertEquals(listOf("k1", "k2"), out.map { it.refId })
    assertTrue(out.none { it.byMeaning })
  }

  @Test fun aMeaningHitThatClearsTheFloorStillShowsAsApproximate() {
    val out = Retriever.search(listOf(keyword("k1")), listOf(meaning("m", .72), meaning("weak", .55)), floor)
    assertEquals(setOf("k1", "m"), out.map { it.refId }.toSet())
    assertTrue(out.single { it.refId == "m" }.byMeaning)
  }

  /** A07: "pricing" matched words in one meeting; another meeting only had a room booking. */
  @Test fun anUnrelatedMeetingsWeakHitDoesNotAppearWhenAnotherMeetingMatchesTheWords() {
    val kw = listOf(keyword("pricing-1", meeting = "m-pricing"), keyword("pricing-2", meeting = "m-pricing"))
    val demoRoom = Retriever.Hit("m-ops", "item", "demo", 0, 0, "Book the demo room for Friday", .57, byMeaning = true)
    val out = Retriever.search(kw, listOf(demoRoom), floor)
    assertEquals(listOf("pricing-1", "pricing-2"), out.map { it.refId })
    assertTrue(out.none { it.meetingId == "m-ops" })
  }

  /**
   * The floor belongs on the cosine, before fusion. After it, `score` is a reciprocal-rank sum
   * (≈ 0.016): a floor of 0.60 on that would empty the screen.
   */
  @Test fun theFloorIsNotAppliedToFusedScores() {
    val out = Retriever.search(listOf(keyword("k1")), listOf(meaning("m", .9)), floor)
    assertEquals(2, out.size)
    assertTrue(out.all { it.score < floor })   // fused scores really are tiny; the rows must survive anyway
  }

  @Test fun aRowTheKeywordListAlsoFoundKeepsItsWordsMarkEvenWhenItsCosineIsDropped() {
    val out = Retriever.search(listOf(keyword("a")), listOf(meaning("a", .30)), floor)
    assertEquals(1, out.size)
    assertFalse(out.single().byMeaning)
  }

  /** Ask's path: the default has no floor, so its retrieval is exactly what fuse alone returns. */
  @Test fun withNoFloorEveryMeaningHitSurvivesEvenANegativeCosine() {
    val mn = listOf(meaning("a", .9), meaning("b", .1), meaning("c", -.2))
    val out = Retriever.search(listOf(keyword("k")), mn, Retriever.NO_FLOOR)
    assertEquals(Retriever.fuse(listOf(keyword("k")), mn).map { it.refId }, out.map { it.refId })
    assertEquals(4, out.size)
  }
}
