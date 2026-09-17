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

  /** A day, not a moment: UTC midnight of the calendar day, so it reads the same anywhere. */
  @Test fun theEpochIsThatCalendarDayAtUtcMidnight() {
    val zone = ZoneId.of("Asia/Kolkata")
    val ms = DateNorm.resolve("Friday", 1789551000000L, zone)!!
    assertEquals(LocalDate.of(2026, 9, 18).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli(), ms)
  }
}

/**
 * The date phrase read off the statement by rule, before the model's reading is consulted.
 * Measured 17 Sep: the 1.5B classifier left date_said empty for "Can you send the proposal
 * Friday?" and "Priya will send the deck tomorrow." on the Mac and the Pixel alike — and a date
 * nobody reads is a chip nobody sees and a card nobody gets. A regex quotes better than a small
 * model; the model's phrase is only used where the rule finds nothing.
 */
class DateSpanTest {
  @Test fun findsTheKnownPhrasesWithTheirPrepositionAsSpoken() {
    assertEquals("Friday", DateNorm.spanIn("Can you send the proposal Friday?"))
    assertEquals("tomorrow", DateNorm.spanIn("Priya will send the deck tomorrow."))
    assertEquals("on Thursday", DateNorm.spanIn("so let's revisit that on Thursday."))
    assertEquals("by the 3rd", DateNorm.spanIn("We need the numbers by the 3rd, please."))
    assertEquals("next Friday", DateNorm.spanIn("Ship it next Friday."))
    assertEquals("by end of the week", DateNorm.spanIn("I'll have it by end of the week"))
    assertEquals("in two weeks", DateNorm.spanIn("Let's review in two weeks."))
    assertEquals("next week", DateNorm.spanIn("Priya will send the deck next week"))
    assertEquals("today", DateNorm.spanIn("Can we close it today?"))
  }

  @Test fun keepsTheCasingAsSpokenAndTheFirstPhraseOnly() {
    assertEquals("on Monday", DateNorm.spanIn("We agreed to ship on Monday, or Friday at the latest."))
    assertEquals("On Monday", DateNorm.spanIn("On Monday we ship."))
  }

  @Test fun findsNothingWhereThereIsNoDate() {
    assertEquals(null, DateNorm.spanIn("We also need to decide on the venue for the launch."))
    assertEquals(null, DateNorm.spanIn("The sundae was good"))       // "sun" is not Sunday
    assertEquals(null, DateNorm.spanIn("Monday's report was late"))  // a past reference, possessive
    assertEquals(null, DateNorm.spanIn(""))
  }
}
