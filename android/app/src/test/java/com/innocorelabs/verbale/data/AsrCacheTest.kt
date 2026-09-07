package com.innocorelabs.verbale.data

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The cache's contract at the level that does not need a device: a window is identified by its
 * exact boundaries and its model, and the arrays handed to nativeTranscribe stay parallel and in
 * start order.
 *
 * That last property is load-bearing and silent when broken. nativeTranscribe pairs ranges[i*2]
 * with json[i]; if the two ever came back in different orders, every window would be served the
 * wrong text under the right timestamps — a transcript that reads plausibly and is wrong.
 */
class AsrCacheTest {
  private data class Row(val startMs: Long, val endMs: Long, val model: String, val segments: String)

  /** Mirrors the SQL: WHERE meeting_id=? AND model=? ORDER BY start_ms. */
  private fun windows(rows: List<Row>, model: String): Pair<LongArray, Array<String>> {
    val kept = rows.filter { it.model == model }.sortedBy { it.startMs }
    val ranges = ArrayList<Long>()
    val json = ArrayList<String>()
    for (r in kept) { ranges.add(r.startMs); ranges.add(r.endMs); json.add(r.segments) }
    return Pair(ranges.toLongArray(), json.toTypedArray())
  }

  @Test
  fun ranges_and_json_stay_parallel_and_ordered() {
    // Deliberately inserted out of order: the query, not the insert, decides the pairing.
    val rows = listOf(
      Row(30000, 55000, "ggml-base-q5_1.bin", """[{"t0":0,"t1":500,"text":"again"}]"""),
      Row(0, 30000, "ggml-base-q5_1.bin", """[{"t0":0,"t1":1000,"text":"hello"}]"""),
    )
    val (ranges, json) = windows(rows, "ggml-base-q5_1.bin")
    assertArrayEquals(longArrayOf(0, 30000, 30000, 55000), ranges)
    assertEquals(ranges.size / 2, json.size)
    assertTrue(json[0].contains("hello"))
    assertTrue(json[1].contains("again"))
  }

  @Test
  fun a_different_model_is_a_different_cache() {
    val rows = listOf(Row(0, 30000, "ggml-base-q5_1.bin", """[{"t0":0,"t1":1,"text":"x"}]"""))
    assertEquals(1, windows(rows, "ggml-base-q5_1.bin").second.size)
    // Changing the weights must invalidate everything rather than mix two models' output.
    assertEquals(0, windows(rows, "ggml-small-q5_1.bin").second.size)
  }

  @Test
  fun an_empty_cache_yields_empty_arrays() {
    val (ranges, json) = windows(emptyList(), "ggml-base-q5_1.bin")
    assertEquals(0, ranges.size)
    assertEquals(0, json.size)
  }

  @Test
  fun a_window_that_decoded_to_nothing_is_still_a_row() {
    // Storing it is what stops the live loop retrying a genuinely silent window every pass.
    val rows = listOf(Row(0, 30000, "ggml-base-q5_1.bin", "[]"))
    val (ranges, json) = windows(rows, "ggml-base-q5_1.bin")
    assertArrayEquals(longArrayOf(0, 30000), ranges)
    assertEquals("[]", json[0])
  }
}
