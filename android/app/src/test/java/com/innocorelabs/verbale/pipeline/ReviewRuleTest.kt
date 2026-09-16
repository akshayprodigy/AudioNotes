package com.innocorelabs.verbale.pipeline

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * What the model could not settle. The defects it guards: a queue that asks about everything
 * (nobody does a 40-card chore), a queue that misses a contradiction, and a rule that overwrites
 * a person's own yes or no. Shared with reviewRule.test.ts row for row.
 */
class ReviewRuleTest {
  private val golden: JSONObject by lazy {
    val f = listOf("../../cpp/tests/golden/review_rule.json", "../cpp/tests/golden/review_rule.json", "cpp/tests/golden/review_rule.json")
      .map { File(it) }.firstOrNull { it.exists() }
      ?: error("review_rule.json not found from ${File(".").absolutePath}")
    JSONObject(f.readText())
  }

  @Test fun everyRowOfTheGoldenTable() {
    val cases = golden.getJSONArray("cases")
    assertTrue(cases.length() > 8)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val d = ReviewRule.decide(
        kind = c.getString("kind"), type = c.getString("type"), status = c.getString("status"),
        confidence = c.getString("confidence"), ownerKind = c.getString("ownerKind"),
        dateSaid = c.getString("dateSaid").ifEmpty { null },
        dateNorm = if (c.isNull("dateNorm")) null else c.getLong("dateNorm"),
        currentReview = c.getString("review"),
      )
      assertEquals(c.getString("name"), c.getString("expect"), d.review)
      assertEquals(c.getString("name"), if (c.isNull("reason")) null else c.getString("reason"), d.reason)
    }
  }
}
