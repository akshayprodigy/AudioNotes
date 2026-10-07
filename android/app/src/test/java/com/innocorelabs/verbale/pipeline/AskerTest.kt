package com.innocorelabs.verbale.pipeline

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The pure parts of asking a meeting. The defects they guard: a free user reaching the model, a
 * question asked while the writer is resident twice (an OOM on a 3 GB phone), a ninth passage,
 * a passage with no name, and a stored cite that cannot be played.
 */
class AskerTest {
  @Test fun theGateFailsInOrder() {
    assertEquals(Asker.Refusal.NOT_PRO, Asker.gate(entitled = false, writer = true, embed = true, capable = true, busy = false))
    // The paywall before a missing download: a free user with nothing installed is sent to Pro,
    // not to Settings for a model they cannot fetch.
    assertEquals(Asker.Refusal.NOT_PRO, Asker.gate(entitled = false, writer = false, embed = false, capable = false, busy = true))
    assertEquals(Asker.Refusal.NO_MODEL, Asker.gate(entitled = true, writer = false, embed = true, capable = true, busy = false))
    assertEquals(Asker.Refusal.NO_MODEL, Asker.gate(entitled = true, writer = true, embed = false, capable = true, busy = false))
    assertEquals(Asker.Refusal.NOT_CAPABLE, Asker.gate(entitled = true, writer = true, embed = true, capable = false, busy = false))
    assertEquals(Asker.Refusal.BUSY, Asker.gate(entitled = true, writer = true, embed = true, capable = true, busy = true))
    assertNull(Asker.gate(entitled = true, writer = true, embed = true, capable = true, busy = false))
  }

  @Test fun passagesAreTheTopEightFusedHitsWithTheirSpeakersNamed() {
    val hits = (1..12).map {
      Retriever.Hit("m1", "utterance", "u$it", it * 1000L, it * 1000L + 500, "words $it", 1.0 / it, it % 2 == 0)
    }
    val names = mapOf("s1" to "Priya")
    val p = Asker.passages(hits, speakerOf = { if (it == "u2") "s1" else null }, names = names)
    assertEquals(8, p.size)
    assertEquals("Someone", p[0].speaker)
    assertEquals("Priya", p[1].speaker)
    assertEquals(1000L, p[0].startMs)
    assertEquals("u1", p[0].refId)
    assertEquals("words 1", p[0].text)
  }

  /** The model reads the whole passage; the screen's snippet is a fragment with markers in it. */
  @Test fun aPassageIsTheWholeTextNotTheSnippet() {
    val hit = Retriever.Hit("m1", "utterance", "u1", 0, 0, "Only a \u0002draft\u0003…", 1.0, false,
      text = "Only a \u0002draft\u0003; the final version needs another week.")
    val p = Asker.passages(listOf(hit), speakerOf = { null }, names = emptyMap())
    assertEquals("Only a draft; the final version needs another week.", p[0].text)
  }

  /**
   * F17. This test used to pin the OLD behaviour — "an item or the summary is spoken by the
   * Minutes" — which is exactly what put "[4] Minutes · 0:00" in front of the A07: an item hit was
   * labelled "Minutes" and the summary was indexed at 0. An item was SAID, on a line, at a moment;
   * a citation to it names that line's speaker and that moment. Only what nobody said (the
   * summary, a minutes passage, the title, a hand-typed row) is "Minutes", and none of those is a
   * moment a person can be taken to.
   */
  @Test fun anItemIsSpokenByTheSpeakerOfTheLineItCameFromAtThatMoment() {
    val hits = listOf(Retriever.Hit("m1", "item", "i1", 5000, 5000, "Send the proposal", 1.0, false))
    val p = Asker.passages(
      hits, speakerOf = { null }, names = mapOf("s1" to "Priya"),
      itemMoment = { if (it == "i1") Asker.ItemMoment("s1", 5000L) else null },
    )
    assertEquals("Priya", p[0].speaker)
    assertEquals(5000L, p[0].startMs)
    assertEquals(true, p[0].anchored)
  }

  @Test fun anItemWithNoNamedSpeakerIsStillSomeoneNeverMinutes() {
    val hits = listOf(Retriever.Hit("m1", "item", "i1", 5000, 5000, "Send the proposal", 1.0, false))
    val p = Asker.passages(hits, speakerOf = { null }, names = emptyMap(), itemMoment = { Asker.ItemMoment("s9", 5000L) })
    assertEquals("Someone", p[0].speaker)
    assertEquals(true, p[0].anchored)
  }

  @Test fun theSummaryAMinutesPassageTheTitleAndAHandTypedItemHaveNoMoment() {
    val hits = listOf(
      Retriever.Hit("m1", "summary", "m1", 0, 0, "A short meeting", .9, true),
      Retriever.Hit("m1", "minute", "min1", 0, 0, "Decided: ship it", .8, false),
      Retriever.Hit("m1", "title", null, 0, 0, "Standup", .7, false),
      Retriever.Hit("m1", "item", "typed", 0, 0, "Book the venue", .6, false),
    )
    // The hand-typed row never claimed a moment, so the lookup answers null for it.
    val p = Asker.passages(hits, speakerOf = { null }, names = emptyMap(), itemMoment = { null })
    assertEquals(listOf("Minutes", "Minutes", "Minutes", "Minutes"), p.map { it.speaker })
    assertEquals(listOf(false, false, false, false), p.map { it.anchored })
  }

  /** An utterance is a moment even at 0:00: the first line of a meeting is a line, not "no moment". */
  @Test fun anUtteranceAtTheVeryStartIsStillAMoment() {
    val hits = listOf(Retriever.Hit("m1", "utterance", "u1", 0, 0, "Hello", 1.0, false))
    assertEquals(true, Asker.passages(hits, speakerOf = { "s1" }, names = mapOf("s1" to "Priya"))[0].anchored)
  }

  /**
   * THE A07 REGRESSION. The model cited [4], a minutes passage. That cite is removed from the
   * answer before validation, so the sentence it supported is uncited and the validator drops it;
   * an answer that was resting on that cite alone is the "nothing" state. It is never shown as
   * "Minutes · 0:00".
   */
  @Test fun aCiteToAMinutesPassageIsRemovedNotShownAsMinutesAtZero() {
    val ps = listOf(
      Asker.Passage("Priya", 5000, "a", "u1"),
      Asker.Passage("Minutes", 0, "Decided: ship it", "min1", anchored = false),
    )
    assertEquals("Ship on Friday per Priya [1] and the minutes.", Asker.withoutUnresolvableCites("Ship on Friday per Priya [1] and the minutes [2].", ps))
    assertEquals("Ship on Friday.", Asker.withoutUnresolvableCites("Ship on Friday [2].", ps))
    // A cite the passages do not have at all is left for the validator, which strips it.
    assertEquals("Friday [9].", Asker.withoutUnresolvableCites("Friday [9].", ps))
  }

  @Test fun theNothingStatePointsOnlyAtPassagesThatHaveAMoment() {
    val ps = listOf(
      Asker.Passage("Minutes", 0, "s", "m1", anchored = false),
      Asker.Passage("Priya", 5000, "a", "u1"),
      Asker.Passage("Minutes", 0, "t", "m2", anchored = false),
      Asker.Passage("Rahul", 6500, "b", "u2"),
      Asker.Passage("Priya", 9000, "c", "u3"),
      Asker.Passage("Priya", 9500, "d", "u4"),
    )
    assertEquals(listOf(2, 4, 5), Asker.closestResolvable(ps))
    assertEquals(emptyList<Int>(), Asker.closestResolvable(listOf(Asker.Passage("Minutes", 0, "s", "m1", anchored = false))))
  }

  @Test fun aSpeakerRowWithNoNameIsStillSomeone() {
    val hits = listOf(Retriever.Hit("m1", "utterance", "u1", 0, 0, "t", 1.0, false))
    assertEquals("Someone", Asker.passages(hits, speakerOf = { "s9" }, names = mapOf("s9" to null))[0].speaker)
    assertEquals("Someone", Asker.passages(hits, speakerOf = { "s9" }, names = mapOf("s9" to ""))[0].speaker)
    assertEquals("Someone", Asker.passages(hits, speakerOf = { "s9" }, names = emptyMap())[0].speaker)
  }

  @Test fun theStoredCitesAreMomentsInTheOrderTheAnswerGaveThem() {
    val ps = listOf(
      Asker.Passage("Priya", 5000, "a", "u1"),
      Asker.Passage("Rahul", 6500, "b", "u2"),
    )
    val arr = JSONArray(Asker.citesJson(listOf(2, 1), ps))
    assertEquals(2, arr.length())
    assertEquals(2, arr.getJSONObject(0).getInt("n"))
    assertEquals(6500L, arr.getJSONObject(0).getLong("startMs"))
    assertEquals("Rahul", arr.getJSONObject(0).getString("speaker"))
    assertEquals("u2", arr.getJSONObject(0).getString("refId"))
    assertEquals(1, arr.getJSONObject(1).getInt("n"))
  }

  @Test fun aCiteThePassagesDoNotHaveIsDropped() {
    val ps = listOf(Asker.Passage("Priya", 5000, "a", "u1"))
    assertEquals(1, JSONArray(Asker.citesJson(listOf(1, 3), ps)).length())
  }
}
