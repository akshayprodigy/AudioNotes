package com.innocorelabs.verbale.pipeline

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.LocalDate
import java.time.ZoneId

/**
 * A spoken date phrase to a day, or null. The defect it guards: an ETA-style guess — "next week"
 * pinned to some Monday, "another week" pinned to anything — shown as if the meeting had said it.
 * The table is shared with dateNorm.test.ts: the phone and the screen must agree on every row.
 */
class DateNormTest {
  private val golden: JSONObject by lazy {
    val f = listOf("../../cpp/tests/golden/date_norm.json", "../cpp/tests/golden/date_norm.json", "cpp/tests/golden/date_norm.json")
      .map { File(it) }.firstOrNull { it.exists() }
      ?: error("date_norm.json not found from ${File(".").absolutePath}")
    JSONObject(f.readText())
  }

  @Test fun everyRowOfTheGoldenTable() {
    val at = golden.getLong("meetingAt")
    val zone = ZoneId.of(golden.getString("timeZone"))
    val cases = golden.getJSONArray("cases")
    assertTrue(cases.length() > 10)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val expected = if (c.isNull("norm")) null else c.getString("norm")
      assertEquals("said='${c.getString("said")}'", expected, DateNorm.resolveDay(c.getString("said"), at, zone))
    }
  }

  @Test fun theEpochIsThatDaysLocalMidnight() {
    val zone = ZoneId.of("Asia/Kolkata")
    val ms = DateNorm.resolve("Friday", 1789551000000L, zone)!!
    assertEquals(LocalDate.of(2026, 9, 18).atStartOfDay(zone).toInstant().toEpochMilli(), ms)
  }
}
