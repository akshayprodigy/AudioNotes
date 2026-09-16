package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * One list from two. The defects it guards: a row found both ways counted twice, a meaning hit
 * losing its mark (or a keyword hit gaining one), an order that depends on bm25's scale rather
 * than its rank, and a tail that never ends.
 */
class RetrieverTest {
  private fun h(id: String, score: Double, meaning: Boolean = false) =
    Retriever.Hit("m1", "utterance", id, 0, 0, "text $id", score, meaning)

  @Test fun reciprocalRankFusionOrdersByBothLists() {
    val kw = listOf(h("a", 9.0), h("b", 8.0), h("c", 7.0))
    val mn = listOf(h("c", .9, true), h("d", .8, true), h("a", .7, true))
    val fused = Retriever.fuse(kw, mn)
    // a: 1/61 + 1/63; c: 1/63 + 1/61 — a tie, and the keyword order breaks it; b: 1/62; d: 1/62 —
    // another tie, keyword first.
    assertEquals(listOf("a", "c", "b", "d"), fused.map { it.refId })
    assertFalse(fused[0].byMeaning)   // found by words too
    assertFalse(fused[1].byMeaning)
    assertTrue(fused[3].byMeaning)    // only meaning had it
  }

  @Test fun theScaleOfTheScoresDoesNotMatter() {
    val kw = listOf(h("a", 1000.0), h("b", 999.0))
    val mn = listOf(h("b", .001, true), h("a", .0001, true))
    assertEquals(listOf("a", "b"), Retriever.fuse(kw, mn).map { it.refId })
  }

  /**
   * Why k is 60 and not 0: a row halfway down BOTH lists is a better answer than a row at the
   * top of one, and only a smoothed rank says so. With k = 0 the first keyword hit is worth 1
   * and nothing below it can add up to that.
   */
  @Test fun aRowMidwayInBothListsBeatsARowFirstInOneAlone() {
    val kw = (1..60).map { h("k$it", 100.0 - it) } + h("both", 1.0)          // "both" is keyword rank 61
    val mn = (1..60).map { h("m$it", 1.0 - it / 100.0, true) } + h("both", .1, true)  // and meaning rank 61
    val fused = Retriever.fuse(kw, mn, top = 200)
    assertEquals("both", fused.first().refId)
  }

  /** The flag is fuse's to set: whatever a caller put on a keyword hit, found-by-words wins. */
  @Test fun theMarkComesFromMembershipNotFromTheInput() {
    val kwMarkedWrong = listOf(Retriever.Hit("m1", "utterance", "a", 0, 0, "t", 1.0, byMeaning = true))
    val fused = Retriever.fuse(kwMarkedWrong, emptyList())
    assertFalse(fused.single().byMeaning)
  }

  @Test fun aHitInBothListsIsOneRow() {
    val fused = Retriever.fuse(listOf(h("a", 1.0)), listOf(h("a", .5, true)))
    assertEquals(1, fused.size)
    assertFalse(fused[0].byMeaning)
  }

  @Test fun aMeaningOnlyListStillRanks() {
    val fused = Retriever.fuse(emptyList(), listOf(h("x", .9, true), h("y", .8, true)))
    assertEquals(listOf("x", "y"), fused.map { it.refId })
    assertTrue(fused.all { it.byMeaning })
  }

  @Test fun topKCutsTheTail() {
    val fused = Retriever.fuse((1..100).map { h("k$it", 100.0 - it) }, emptyList(), top = 60)
    assertEquals(60, fused.size)
    assertEquals("k1", fused.first().refId)
  }

  @Test fun differentKindsWithTheSameRefAreDifferentRows() {
    val a = Retriever.Hit("m1", "utterance", "x", 0, 0, "t", 1.0, false)
    val b = Retriever.Hit("m1", "item", "x", 0, 0, "t", 1.0, false)
    assertEquals(2, Retriever.fuse(listOf(a), listOf(b)).size)
  }
}
