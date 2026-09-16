package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The unit of meaning search. The defects it guards: a window that grows without bound (one
 * vector for a whole meeting finds nothing), a window that bridges a long silence (two topics in
 * one vector), a speaker's name inside the embedded words (a rename would invalidate every
 * vector), and a hash that cannot tell two texts apart.
 */
class SearchChunkerTest {
  private fun u(id: String, start: Long, end: Long, spk: String?, text: String) = Utt(id, start, end, text, spk)

  @Test fun shortTurnsMergeUpToAHundredWords() {
    val utts = (0 until 30).map { i ->
      u("u$i", i * 2000L, i * 2000L + 1500, "s1", "one two three four five six seven eight nine ten")
    }
    val chunks = SearchChunker.chunks(utts)
    assertEquals(3, chunks.size)                        // 30 × 10 words = 300 → three windows
    assertEquals("u0", chunks[0].refId)
    assertEquals(0L, chunks[0].startMs)
    assertEquals(9 * 2000L + 1500, chunks[0].endMs)     // ten turns per window
    assertEquals("u10", chunks[1].refId)
    assertEquals("s1", chunks[0].speakerId)
    assertFalse(chunks[0].text.contains("s1"))          // the words only, never the speaker
    assertEquals(100, chunks[0].text.split(" ").size)
  }

  @Test fun aWindowNeverExceedsAHundredWords() {
    val utts = (0 until 7).map { i -> u("u$i", i * 1000L, i * 1000L + 900, "s1", (1..30).joinToString(" ") { "w" }) }
    val chunks = SearchChunker.chunks(utts)
    assertTrue(chunks.all { it.text.split(" ").size <= SearchChunker.MAX_WORDS })
    assertEquals(listOf(90, 90, 30), chunks.map { it.text.split(" ").size })
  }

  @Test fun aGapOfMoreThanThirtySecondsStartsANewWindow() {
    val utts = listOf(u("a", 0, 1000, "s1", "hello there"), u("b", 40_000, 41_000, "s2", "back again"))
    val chunks = SearchChunker.chunks(utts)
    assertEquals(2, chunks.size)
    assertEquals("b", chunks[1].refId)
    assertEquals("s2", chunks[1].speakerId)
    assertEquals(40_000L, chunks[1].startMs)
  }

  @Test fun aGapOfExactlyThirtySecondsDoesNot() {
    val utts = listOf(u("a", 0, 1000, "s1", "hello there"), u("b", 31_000, 32_000, "s2", "back again"))
    assertEquals(1, SearchChunker.chunks(utts).size)
  }

  @Test fun oneLongLineIsItsOwnWindow() {
    val long = (1..150).joinToString(" ") { "w$it" }
    val utts = listOf(u("a", 0, 1000, "s1", "short"), u("b", 1000, 9000, "s1", long), u("c", 9000, 9500, "s1", "tail"))
    val chunks = SearchChunker.chunks(utts)
    assertEquals(3, chunks.size)
    assertEquals(long, chunks[1].text)
    assertEquals("c", chunks[2].refId)
  }

  @Test fun blankLinesAreSkippedAndNothingMakesNothing() {
    assertEquals(0, SearchChunker.chunks(emptyList()).size)
    assertEquals(0, SearchChunker.chunks(listOf(u("a", 0, 1, "s1", "   "))).size)
  }

  @Test fun hashIsStableAndSensitiveToTheWords() {
    assertEquals(SearchChunker.hash("a b"), SearchChunker.hash("a b"))
    assertNotEquals(SearchChunker.hash("a b"), SearchChunker.hash("a c"))
    assertNotEquals(SearchChunker.hash("ab"), SearchChunker.hash("ba"))
    assertEquals(-3750763034362895579L, SearchChunker.hash(""))   // FNV-1a's offset basis, as a signed long
  }
}
