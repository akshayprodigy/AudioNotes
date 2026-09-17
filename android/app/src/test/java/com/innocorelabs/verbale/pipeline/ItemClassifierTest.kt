package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.data.AudioDb
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The reply window: what the classifier is allowed to read for one item. The defect it guards:
 * a window that starts at the wrong line, or runs on past the reply into the next topic — the
 * model would then be asked about a contradiction that belongs to another item.
 */
class ItemClassifierTest {
  private fun utt(id: String, start: Long, text: String, spk: String = "s1") = Utt(id, start, start + 1000, text, spk)
  private fun item(utteranceId: String?, startMs: Long) = AudioDb.StoredItem(
    "i1", "action", "Send the proposal Friday", "suggested", "rules@3", startMs, startMs + 1000,
    listOf(AudioDb.StoredSource(startMs, startMs + 1000, 0, 10, utteranceId)), 0L, false,
  )
  private val names = mapOf("s1" to "Priya", "s2" to "Rahul")

  @Test fun startsAtTheSourceLineAndTakesTheRepliesAfterIt() {
    val utts = listOf(
      utt("u0", 0, "Earlier chatter."), utt("u1", 5000, "Can you send the proposal Friday?"),
      utt("u2", 8000, "Only a draft; the final version needs another week.", "s2"), utt("u3", 12000, "Fine."),
    )
    val w = ItemClassifier.windowFor(item("u1", 5000), utts, names)!!
    assertArrayEquals(intArrayOf(0, 1, 2), w.ordinals)
    assertArrayEquals(arrayOf("Priya", "Rahul", "Priya"), w.speakers)
    assertEquals("Can you send the proposal Friday?", w.texts[0])
    assertEquals("s1", w.sourceSpeakerId)
  }

  @Test fun isBoundedByTurns() {
    val utts = (0..9).map { utt("u$it", it * 1000L, "line $it") }
    val w = ItemClassifier.windowFor(item("u2", 2000), utts, names)!!
    assertEquals(ItemClassifier.REPLY_WINDOW_TURNS + 1, w.texts.size)
    assertEquals("line 2", w.texts[0])
  }

  @Test fun isBoundedByTime() {
    val utts = listOf(utt("u0", 0, "a"), utt("u1", 30_000, "b"), utt("u2", 200_000, "c — a different topic"))
    val w = ItemClassifier.windowFor(item("u0", 0), utts, names)!!
    assertEquals(2, w.texts.size)
  }

  @Test fun findsTheSourceByTimeWhenTheIdIsStale() {
    // A reprocess re-mints utterance ids; the anchor time still lands inside the right line.
    val utts = listOf(utt("n0", 0, "a"), utt("n1", 5000, "the line"), utt("n2", 8000, "reply"))
    val w = ItemClassifier.windowFor(item("old-id", 5200), utts, names)!!
    assertEquals("the line", w.texts[0])
  }

  @Test fun givesUpWhenTheSourceIsGone() {
    val utts = listOf(utt("n0", 0, "a"))
    assertNull(ItemClassifier.windowFor(item("old-id", 99_000), utts, names))
  }

  /** The rule reads the date first; the model's phrase fills in only where the rule has nothing. */
  @Test fun theRuleReadsTheDateBeforeTheModel() {
    assertEquals("Friday", ItemClassifier.dateSaidFor("Can you send the proposal Friday?", ""))
    assertEquals("Friday", ItemClassifier.dateSaidFor("Can you send the proposal Friday?", "[0]"))
    assertEquals("after the launch", ItemClassifier.dateSaidFor("Let's revisit pricing after the launch", "after the launch"))
    assertEquals(null, ItemClassifier.dateSaidFor("We also need to decide on the venue.", "  "))
  }

  /**
   * What is read, and read again. An item read by an older classifier is read again — that is
   * how a better prompt reaches a library already classified — but never one a person settled,
   * and never a hand-typed row.
   */
  @Test fun unreadAndStaleItemsArePendingSettledOnesAreNot() {
    val current = "rules@1" + ItemClassifier.GEN_SUFFIX
    assertEquals(true, ItemClassifier.isPending(hasRecord = false, genVersion = "rules@1", review = "suggested"))
    assertEquals(true, ItemClassifier.isPending(hasRecord = true, genVersion = "rules@1+qwen2.5-1.5b/classify@1", review = "needs_review"))
    assertEquals(false, ItemClassifier.isPending(hasRecord = true, genVersion = current, review = "needs_review"))
    assertEquals(false, ItemClassifier.isPending(hasRecord = true, genVersion = "rules@1+qwen2.5-1.5b/classify@1", review = "confirmed"))
    assertEquals(false, ItemClassifier.isPending(hasRecord = false, genVersion = "rules@1", review = "rejected"))
    assertEquals(false, ItemClassifier.isPending(hasRecord = false, genVersion = com.innocorelabs.verbale.data.AudioDb.Gen.USER, review = "suggested"))
  }

  @Test fun aReReadNeverStacksSuffixes() {
    assertEquals("rules@1", ItemClassifier.baseGen("rules@1+qwen2.5-1.5b/classify@1"))
    assertEquals("rules@1", ItemClassifier.baseGen("rules@1"))
    assertEquals("rules@1" + ItemClassifier.GEN_SUFFIX, ItemClassifier.baseGen("rules@1+qwen2.5-1.5b/classify@1") + ItemClassifier.GEN_SUFFIX)
  }
}
