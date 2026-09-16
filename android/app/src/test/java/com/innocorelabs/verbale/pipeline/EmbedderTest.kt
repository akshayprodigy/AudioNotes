package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.data.AudioDb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The plan behind a fill: embed only chunks whose words are new, drop rows whose words are
 * gone, leave the rest. The defects it guards: re-embedding a whole meeting on every hand
 * edit, and a stale row for a sentence nobody said any more surfacing in search.
 */
class EmbedderTest {
  private fun w(kind: String, ref: String, text: String) = Embedder.Want(kind, ref, 0, 1000, null, text)

  @Test fun onlyChunksWhoseHashIsNewAreEmbeddedAndStaleRowsAreDropped() {
    val wanted = listOf(
      w("turn", "u1", "the proposal is due friday"),
      w("turn", "u2", "only a draft"),
      w("item", "i1", "send the proposal"),
    )
    val have = setOf(
      AudioDb.VecKey(SearchChunker.hash("only a draft"), "u2"),
      AudioDb.VecKey(SearchChunker.hash("gone words"), "u7"),
    )
    val plan = Embedder.plan(wanted, have)
    assertEquals(listOf("u1", "i1"), plan.toEmbed.map { it.refId })
    assertEquals(setOf(AudioDb.VecKey(SearchChunker.hash("gone words"), "u7")), plan.toDelete)
  }

  @Test fun anUnchangedMeetingIsNoWorkAtAll() {
    val wanted = listOf(w("turn", "u1", "a"), w("turn", "u2", "b"))
    val plan = Embedder.plan(wanted, wanted.map { it.key }.toSet())
    assertTrue(plan.toEmbed.isEmpty())
    assertTrue(plan.toDelete.isEmpty())
  }

  @Test fun theSameWordsAtAnotherMomentAreAnotherRow() {
    // "yes" said twice: two rows (two moments a search can land on), one hash — fill embeds the
    // words once and writes them twice. And a window that moved (same words, new first line)
    // is dropped and re-added rather than left pointing at the old moment.
    val wanted = listOf(w("turn", "u1", "yes"), w("turn", "u9", "yes"))
    val plan = Embedder.plan(wanted, setOf(AudioDb.VecKey(SearchChunker.hash("yes"), "u5")))
    assertEquals(listOf("u1", "u9"), plan.toEmbed.map { it.refId })
    assertEquals(setOf(AudioDb.VecKey(SearchChunker.hash("yes"), "u5")), plan.toDelete)
    assertEquals(1, plan.toEmbed.map { it.hash }.toSet().size)
  }
}
