package com.innocorelabs.verbale.pipeline

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * What a typed item wears in an export. The defects it guards: a free-tier row growing labels it
 * never earned, "Open" printed as if it were news, a day label the document and the screen
 * disagree about, and "Sept". Shared with recordLabels.test.ts row for row.
 */
class RecordLabelsTest {
  private val golden: JSONObject by lazy {
    val f = listOf("../../cpp/tests/golden/record_labels.json", "../cpp/tests/golden/record_labels.json", "cpp/tests/golden/record_labels.json")
      .map { File(it) }.firstOrNull { it.exists() }
      ?: error("record_labels.json not found from ${File(".").absolutePath}")
    JSONObject(f.readText())
  }

  private fun JSONObject.str(k: String): String? = if (isNull(k)) null else getString(k)

  @Test fun everyRowOfTheGoldenTable() {
    val cases = golden.getJSONArray("cases")
    assertTrue(cases.length() > 7)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val dateNorm = if (c.isNull("dateNorm")) null else c.getLong("dateNorm")
      val l = RecordLabels.labelsFor(c.str("itemType"), c.str("status"), dateNorm)
      assertEquals(c.getString("name"), c.str("type"), l.type)
      assertEquals(c.getString("name"), c.str("statusLabel"), l.status)
      assertEquals(c.getString("name"), c.str("day"), l.day)
      assertEquals(c.getString("name"), c.getString("suffix"), RecordLabels.suffix(c.str("itemType"), c.str("status"), dateNorm))
    }
  }
}
