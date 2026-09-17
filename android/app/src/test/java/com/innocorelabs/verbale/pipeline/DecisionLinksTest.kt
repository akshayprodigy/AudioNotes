package com.innocorelabs.verbale.pipeline

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * DecisionLinks.link against decision_links.json. Cosines in the golden are INJECTED — each case
 * passes a lookup matrix in place of a real vector dot product, so the threshold arithmetic is
 * pinned directly rather than through vectors engineered to a target cosine. sharedContentWord
 * still runs over the real `text` fields.
 */
class DecisionLinksTest {
  private val golden: JSONObject by lazy {
    val f = listOf(
      "../../cpp/tests/golden/decision_links.json",
      "../cpp/tests/golden/decision_links.json",
      "cpp/tests/golden/decision_links.json",
    ).map { File(it) }.firstOrNull { it.exists() }
      ?: error("decision_links.json not found from ${File(".").absolutePath}")
    JSONObject(f.readText())
  }

  @Test fun everyRowOfTheGoldenTable() {
    val cases = golden.getJSONArray("cases")
    assertTrue(cases.length() >= 10)
    for (i in 0 until cases.length()) {
      val case = cases.getJSONObject(i)
      val name = case.getString("name")
      val decisionsJson = case.getJSONArray("decisions")
      val decisions = (0 until decisionsJson.length()).map { j ->
        val d = decisionsJson.getJSONObject(j)
        DecisionLinks.Decision(
          itemId = d.getString("itemId"),
          meetingId = "m:${d.getString("itemId")}",
          meetingAt = d.getLong("meetingAt"),
          text = d.getString("text"),
          vec = if (d.getBoolean("vec")) floatArrayOf(0f) else null,
        )
      }
      val indexOf = decisions.withIndex().associate { (idx, d) -> d.itemId to idx }
      val cos = case.getJSONArray("cos")
      val cosineOf = { a: DecisionLinks.Decision, b: DecisionLinks.Decision ->
        cos.getJSONArray(indexOf.getValue(a.itemId)).getDouble(indexOf.getValue(b.itemId)).toFloat()
      }

      val expected = case.getJSONObject("links")
      val got = DecisionLinks.link(decisions, cosineOf)

      assertEquals(name, expected.length(), got.size)
      for (key in expected.keys()) {
        assertEquals("$name: link for $key", expected.getString(key), got[key])
      }
    }
  }
}
