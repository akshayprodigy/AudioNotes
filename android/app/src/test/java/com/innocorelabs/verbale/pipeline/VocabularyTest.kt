package com.innocorelabs.verbale.pipeline

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import java.io.File

class VocabularyTest {
  private val golden: JSONObject by lazy {
    val f = listOf(
      "../../cpp/tests/golden/vocabulary_apply.json",
      "../cpp/tests/golden/vocabulary_apply.json",
      "cpp/tests/golden/vocabulary_apply.json",
    ).map { File(it) }.firstOrNull { it.exists() }
      ?: error("vocabulary_apply.json not found from ${File(".").absolutePath}")
    JSONObject(f.readText())
  }

  @Test fun everyRowOfTheGoldenTable() {
    val cases = golden.getJSONArray("cases")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val rj = c.getJSONArray("rules")
      val rules = (0 until rj.length()).map { rj.getJSONObject(it) }
        .map { Vocabulary.Rule(it.getString("heard"), it.getString("meant")) }
      assertEquals(c.getString("name"), c.getString("expect"),
        Vocabulary.apply(c.getString("text"), rules))
    }
  }

  @Test fun untouchedTextIsTheSameInstance() {
    assertEquals("x", Vocabulary.apply("x", listOf(Vocabulary.Rule("y", "z"))))
    assertSame("x", Vocabulary.apply("x", emptyList()))
  }
}
