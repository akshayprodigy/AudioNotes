package com.innocorelabs.verbale.pipeline

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class TemplateSuggesterTest {
  private val golden: JSONObject by lazy {
    val f = listOf(
      "../../cpp/tests/golden/template_suggest.json",
      "../cpp/tests/golden/template_suggest.json",
      "cpp/tests/golden/template_suggest.json",
    ).map { File(it) }.firstOrNull { it.exists() }
      ?: error("template_suggest.json not found from ${File(".").absolutePath}")
    JSONObject(f.readText())
  }

  @Test fun everyRowOfTheGoldenTable() {
    val cases = golden.getJSONArray("cases")
    assertTrue(cases.length() > 8)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val remembered = if (c.isNull("remembered")) null else c.getString("remembered")
      val got = TemplateSuggester.suggest(
        transcript = c.getString("transcript"),
        speakerCount = c.getInt("speakerCount"),
        remembered = remembered,
      )
      assertEquals(c.getString("name"), c.getString("expect"), got)
    }
  }
}
