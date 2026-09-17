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

  @Test fun anItemOrTheSummaryIsSpokenByTheMinutes() {
    val hits = listOf(
      Retriever.Hit("m1", "item", "i1", 5000, 5000, "Send the proposal", 1.0, false),
      Retriever.Hit("m1", "summary", "m1", 0, 0, "A short meeting", .9, true),
    )
    val p = Asker.passages(hits, speakerOf = { null }, names = emptyMap())
    assertEquals(listOf("Minutes", "Minutes"), p.map { it.speaker })
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
