package com.innocorelabs.verbale.pipeline

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class TemplateLabelsTest {
  private val golden: JSONObject by lazy {
    val f = listOf(
      "../../cpp/tests/golden/template_labels.json",
      "../cpp/tests/golden/template_labels.json",
      "cpp/tests/golden/template_labels.json",
    ).map { File(it) }.firstOrNull { it.exists() }
      ?: error("template_labels.json not found from ${File(".").absolutePath}")
    JSONObject(f.readText())
  }

  @Test fun everyRowOfTheGoldenTable() {
    val cases = golden.getJSONArray("cases")
    assertTrue(cases.length() > 7)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val id = if (c.isNull("id")) null else c.getString("id")
      assertEquals(c.getString("label"), TemplateLabels.labelFor(id))
    }
  }
}
