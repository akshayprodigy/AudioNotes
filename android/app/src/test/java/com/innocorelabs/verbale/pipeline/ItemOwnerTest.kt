package com.innocorelabs.verbale.pipeline

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A speaker rename reaches an action's owner on every native surface (search index, embeddings,
 * threads, exports) because they all resolve through [ItemOwner.resolve]. The vectors here are
 * the same ones src/pipeline/__tests__/itemOwner.test.ts holds the TypeScript twin to.
 */
class ItemOwnerTest {
  private val spk = JSONObject().put("kind", "speaker").put("id", "s1").toString()

  @Test fun aRenamedSpeakerShowsItsCurrentNameAndNeverTheOldOne() {
    val out = ItemOwner.resolve("Send the report — Speaker 1", spk, mapOf("s1" to "Priya"))
    assertEquals("Send the report — Priya", out)
    assertEquals(false, out.contains("Speaker 1"))
  }

  @Test fun theDueTailSurvives() {
    assertEquals(
      "Update the roadmap — Priya (due by Thursday)",
      ItemOwner.resolve("Update the roadmap — Speaker 1 (due by Thursday)", spk, mapOf("s1" to "Priya")),
    )
  }

  @Test fun anUnassignedTokenIsReplacedWhenTheClassifierSaidSpeaker() {
    assertEquals(
      "Ship it — Priya",
      ItemOwner.resolve("Ship it — Unassigned", spk, mapOf("s1" to "Priya")),
    )
  }

  @Test fun aNamedPersonInTheTextIsLeftAlone() {
    val person = JSONObject().put("kind", "person").put("name", "Maya").toString()
    assertEquals("Send the summary — Maya", ItemOwner.resolve("Send the summary — Maya", person, mapOf("s1" to "Priya")))
    // No owner_json at all (every item the rules wrote before the owner was recorded).
    assertEquals("Send the summary — Maya", ItemOwner.resolve("Send the summary — Maya", null, mapOf("s1" to "Priya")))
  }

  @Test fun onlyKindSpeakerResolvesWhateverElseTheRecordCarries() {
    val person = JSONObject().put("kind", "person").put("id", "s1").put("name", "Maya").toString()
    assertEquals("Send it — Maya", ItemOwner.resolve("Send it — Maya", person, mapOf("s1" to "Priya")))
    assertNull(ItemOwner.speakerId(person))
  }

  @Test fun aHandTypedOwnerIsLeftAlone() {
    val unassigned = JSONObject().put("kind", "unassigned").toString()
    assertEquals("Call Dana — Dana", ItemOwner.resolve("Call Dana — Dana", unassigned, mapOf("s1" to "Priya")))
  }

  @Test fun aSpeakerWeHaveNoNameForKeepsTheStoredText() {
    assertEquals("Do it — Speaker 1", ItemOwner.resolve("Do it — Speaker 1", spk, emptyMap()))
    assertEquals("Do it — Speaker 1", ItemOwner.resolve("Do it — Speaker 1", spk, mapOf("s1" to null)))
    assertEquals("Do it — Speaker 1", ItemOwner.resolve("Do it — Speaker 1", spk, mapOf("s1" to "  ")))
    assertEquals("Do it — Speaker 1", ItemOwner.resolve("Do it — Speaker 1", "not json", mapOf("s1" to "Priya")))
  }

  @Test fun theRuleRecordsTheSourceSpeakerOnlyWhenTheTokenIsTheirName() {
    assertEquals(
      "s1",
      ItemOwner.speakerId(ItemOwner.ruleSpeakerJson("I will send it — Speaker 1", "s1", "Speaker 1")),
    )
    // "Maya will …" said by Speaker 1: the token is Maya, not the speaker.
    assertNull(ItemOwner.ruleSpeakerJson("Maya will send it — Maya", "s1", "Speaker 1"))
    assertNull(ItemOwner.ruleSpeakerJson("Someone should — Unassigned", "s1", "Speaker 1"))
    assertNull(ItemOwner.ruleSpeakerJson("I will send it — Speaker 1", null, "Speaker 1"))
    assertNull(ItemOwner.ruleSpeakerJson("I will send it — Speaker 1", "s1", null))
  }

  @Test fun splitMirrorsTheTypeScriptParser() {
    val p = ItemOwner.split("Fix the thing, — Speaker 2 (due next week)")
    assertEquals("Fix the thing,", p.body)
    assertEquals("Speaker 2", p.owner)
    assertEquals("(due next week)", p.dueSuffix)
    assertNull(ItemOwner.split("No suffix here").owner)
  }

  // ---- The rule overview embeds the stored text; a rename has to reach it too -------------------

  @Test fun aRenamedOwnerReachesTheRuleOverviewToo() {
    val overview = "Next: Send the report. — Speaker 1 (due by Friday); Book the room. — Maya. 2 action items."
    val out = ItemOwner.renameWithin(
      overview,
      listOf("Send the report. — Speaker 1 (due by Friday)" to "Send the report. — Priya (due by Friday)"),
    )
    assertEquals("Next: Send the report. — Priya (due by Friday); Book the room. — Maya. 2 action items.", out)
  }

  @Test fun aRenameWithNothingToSwapLeavesTheOverviewAlone() {
    assertEquals("Decided: ship Monday.", ItemOwner.renameWithin("Decided: ship Monday.", emptyList()))
    assertEquals("same", ItemOwner.renameWithin("same", listOf("same" to "same", "" to "x")))
  }
}
