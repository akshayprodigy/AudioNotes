package com.innocorelabs.verbale.pipeline

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.cos
import kotlin.math.sin

/**
 * PeopleMatch.suggest against cpp/tests/golden/people_match.json.
 *
 * The golden gives each person's cosine to the speaker by name; the test rebuilds unit vectors that
 * yield those cosines (speaker = [1, 0, 0, ...], person = [cos, sqrt(1-cos²), 0, ...]) so the real
 * FloatArray dot product runs. This pins the threshold and margin arithmetic directly rather than
 * through a real diarizer.
 */
class PeopleMatchTest {
  private val golden: JSONObject by lazy {
    val f = listOf(
      "../../cpp/tests/golden/people_match.json",
      "../cpp/tests/golden/people_match.json",
      "cpp/tests/golden/people_match.json",
    ).map { File(it) }.firstOrNull { it.exists() }
      ?: error("people_match.json not found from ${File(".").absolutePath}")
    JSONObject(f.readText())
  }

  private val speaker = FloatArray(2) { if (it == 0) 1f else 0f }

  private fun personVector(cosine: Double): FloatArray {
    val s = kotlin.math.sqrt(1.0 - cosine * cosine).toFloat()
    return floatArrayOf(cosine.toFloat(), s)
  }

  @Test fun everyRowOfTheGoldenTable() {
    val cases = golden.getJSONArray("cases")
    assertTrue(cases.length() >= 7)
    for (i in 0 until cases.length()) {
      val case = cases.getJSONObject(i)
      val name = case.getString("name")
      val displayName = if (case.has("displayName")) case.getString("displayName") else "Speaker 1"
      val people = (0 until case.getJSONArray("people").length()).map { j ->
        val p = case.getJSONArray("people").getJSONObject(j)
        PeopleMatch.Person(
          id = p.getString("id"),
          name = p.getString("name"),
          voice = personVector(p.getDouble("cosine")),
        )
      }
      val result = PeopleMatch.suggest(speaker, people, displayName)
      if (case.isNull("expected")) {
        assertNull("case '$name': expected null but got '$result'", result)
      } else {
        assertEquals("case '$name': expected '${case.getString("expected")}'", case.getString("expected"), result)
      }
    }
  }

  @Test fun constantsMatchTheGolden() {
    assertEquals(golden.getJSONObject("constants").getDouble("MATCH_COSINE"), PeopleMatch.MATCH_COSINE.toDouble(), 1e-6)
    assertEquals(golden.getJSONObject("constants").getDouble("MATCH_MARGIN"), PeopleMatch.MATCH_MARGIN.toDouble(), 1e-6)
  }
}
