package com.innocorelabs.verbale.pipeline

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * F24's Kotlin half: the plumbing around the C++ fact check, with the native function replaced by
 * a stub. The RULES (what counts as a claim, what supports it) are pinned in
 * `cpp/tests/test_fact_check.cpp`; what is pinned here is that the answer is read back correctly,
 * that the counts add up across a narration's three outputs, that an unverifiable answer stores
 * nothing, and that [Narrator] actually runs every output through it.
 */
class FactGuardTest {

  private fun answer(dropped: Int, classes: String, text: String) = "$dropped|$classes\n$text"

  // ---------------------------------------------------------------------------- parse

  @Test
  fun parseReadsTheNativeAnswer() {
    val c = FactGuard.parse(answer(2, "currency,tense", "The group met.\n\nIt was fine."))
    assertNotNull(c)
    assertEquals(2, c!!.dropped)
    assertEquals(listOf("currency", "tense"), c.classes)
    // The text keeps its own newlines: only the first one is the separator.
    assertEquals("The group met.\n\nIt was fine.", c.text)
  }

  @Test
  fun parseReadsACleanAnswerWithNoClasses() {
    val c = FactGuard.parse(answer(0, "", "All supported."))!!
    assertEquals(0, c.dropped)
    assertEquals(emptyList<String>(), c.classes)
    assertEquals("All supported.", c.text)
  }

  @Test
  fun parseReadsAnEmptiedAnswer() {
    val c = FactGuard.parse(answer(3, "number", ""))!!
    assertEquals("", c.text)
    assertEquals(3, c.dropped)
  }

  @Test
  fun parseRejectsAnythingThatIsNotTheShape() {
    assertNull(FactGuard.parse(""))
    assertNull(FactGuard.parse("no header at all"))
    assertNull(FactGuard.parse("x|number\ntext"))
    assertNull(FactGuard.parse("-1|number\ntext"))
    assertNull(FactGuard.parse("2 number\ntext"))
  }

  // ---------------------------------------------------------------------------- guard

  @Test
  fun guardReturnsTheCheckedTextAndCountsTheDrops() {
    val tally = FactGuard.Tally()
    val out = FactGuard.guard("written", "said", tally, { w, t ->
      assertEquals("written", w)
      assertEquals("said", t)
      answer(1, "date", "Kept sentence.")
    })
    assertEquals("Kept sentence.", out)
    assertEquals(1, tally.dropped)
    assertEquals(listOf("date"), tally.classes)
  }

  /** The fail-closed rule: a check that returns garbage must not become "no check". */
  @Test
  fun guardStoresNothingWhenTheAnswerCannotBeRead() {
    val tally = FactGuard.Tally()
    val out = FactGuard.guard("The report was sent.", "said", tally, { _, _ -> "garbage" })
    assertEquals("", out)
    assertEquals(0, tally.dropped)
  }

  @Test
  fun guardLeavesBlankTextAloneWithoutCallingTheCheck() {
    val tally = FactGuard.Tally()
    var called = false
    val out = FactGuard.guard("  ", "said", tally, { _, _ -> called = true; answer(0, "", "") })
    assertEquals("  ", out)
    assertFalse(called)
  }

  /** A whole output removed is the loudest thing the check does, so it must be countable. */
  @Test
  fun guardCountsAnOutputItEmptied() {
    val tally = FactGuard.Tally()
    val out = FactGuard.guard("It cost $999.", "said", tally, { _, _ -> answer(1, "currency", "") })
    assertEquals("", out)
    assertEquals(1, tally.dropped)
  }

  // ---------------------------------------------------------------------------- tally

  @Test
  fun theTallyAddsAcrossOutputsAndKeepsClassesDistinctInFirstSeenOrder() {
    val t = FactGuard.Tally()
    t.add(FactGuard.Checked("a", 1, listOf("currency")))
    t.add(FactGuard.Checked("b", 2, listOf("date", "currency")))
    t.add(FactGuard.Checked("c", 0, emptyList()))
    assertEquals(3, t.dropped)
    assertEquals(listOf("currency", "date"), t.classes)
    assertEquals("3|currency,date", t.encoded())
  }

  @Test
  fun aCleanNarrationEncodesAsZeroSoAStaleCountIsCleared() {
    assertEquals("0|", FactGuard.Tally().encoded())
    assertEquals("0|", FactGuard.encode(0, emptyList()))
  }

  @Test
  fun theSettingKeyIsPerMeeting() {
    assertEquals("writer_check:m1", FactGuard.settingKey("m1"))
    assertFalse(FactGuard.settingKey("m1") == FactGuard.settingKey("m2"))
  }

  // ---------------------------------------------------------------------------- the wiring

  /**
   * [Narrator.run] needs a Context, a database and a model, so it cannot run here. What can go
   * wrong in it is a single deleted call — the three outputs it stores are narrative, summary and
   * headline, and each must come out of [FactGuard.guard] — so this reads the source and pins the
   * three call sites and their order, the way `check-prompt-fencing.py` pins the fence.
   */
  @Test
  fun narratorChecksEveryOutputBeforeItIsStoredOrBuiltFrom() {
    val src = File("src/main/java/com/innocorelabs/verbale/pipeline/Narrator.kt").readText()
    val calls = Regex("""FactGuard\.guard\(""").findAll(src).count()
    assertEquals("narrative, summary and headline each go through the check", 3, calls)

    val narrative = src.indexOf("val narrative = FactGuard.guard(")
    val summaryPrompt = src.indexOf("nativeLlmSummaryPrompt(narrative)")
    val summary = src.indexOf("val summary = FactGuard.guard(")
    val headlinePrompt = src.indexOf("nativeLlmHeadlinePrompt(summary)")
    val store = src.indexOf("db.replaceMinutes(meetingId, \"llm\"")
    val line = src.indexOf("val line = FactGuard.guard(")
    val setting = src.indexOf("db.putSetting(FactGuard.settingKey(meetingId)")
    assertTrue("all of them are present", listOf(narrative, summaryPrompt, summary, headlinePrompt, store, line, setting).all { it > 0 })
    // The summary is written from the CHECKED narrative, the headline from the CHECKED summary.
    assertTrue(narrative < summaryPrompt)
    assertTrue(summary < headlinePrompt)
    // The counts are written with the rows they describe, after the checks that produced them.
    assertTrue(line < setting)
    assertTrue(summary < store)
  }
}
