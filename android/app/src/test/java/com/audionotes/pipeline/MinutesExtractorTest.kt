package com.audionotes.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mirrors __tests__/minutes.test.ts (JS parity) plus a handful of extra rule-level sanity
 * checks called out in the port task: decision detection, action w/ named owner + due date,
 * question detection, summary-count-first ordering, norm()-based dedup, and the per-kind cap.
 */
class MinutesExtractorTest {
  private val speakers = listOf(
    Spk(id = "s1", displayName = "Akshay"),
    Spk(id = "s2", displayName = "Priya"),
  )

  // Same transcript as __tests__/minutes.test.ts (fields not used by the extractor dropped).
  private val transcript = listOf(
    Utt("Okay so the main thing is the Android MVP. I'll finish the VAD integration by Friday.", "s1"),
    Utt("Can you send me the build config today? Also, what about the iOS timeline?", "s2"),
    Utt("We decided to go with React Native for the UI layer.", "s1"),
    Utt("Priya will prepare the demo script by next week.", "s2"),
    Utt("We need to test on a real mid-range device. Should we buy a Snapdragon 6-series phone?", "s1"),
    Utt("Let's finalize the pricing after the alpha.", "s2"),
    Utt("Nothing much else, just casual chat about the weather.", "s1"),
    Utt("I'll finish the VAD integration by Friday.", "s1"), // duplicate -> deduped
  )

  private fun byKind(mins: List<DraftMinute>, k: String) = mins.filter { it.kind == k }

  // --- mirrors __tests__/minutes.test.ts ---------------------------------------------------

  @Test fun leadsWithFactualOverviewSummary() {
    val mins = MinutesExtractor.extract(transcript, speakers)
    assertEquals("summary", mins[0].kind)
  }

  @Test fun capturesTheExplicitDecision() {
    val mins = MinutesExtractor.extract(transcript, speakers)
    val decisions = byKind(mins, "decision")
    assertEquals(1, decisions.size)
    assertTrue(decisions[0].content.contains("React Native"))
  }

  @Test fun attributesFirstPersonActionsToTheSpeaker() {
    val mins = MinutesExtractor.extract(transcript, speakers)
    assertTrue(byKind(mins, "action").any { it.content.contains("Akshay") })
  }

  @Test fun detectsANamedOwner() {
    val mins = MinutesExtractor.extract(transcript, speakers)
    assertTrue(byKind(mins, "action").any { it.content.contains("Priya") })
  }

  @Test fun detectsADueDate() {
    val mins = MinutesExtractor.extract(transcript, speakers)
    val dueByFriday = Regex("due by Friday", RegexOption.IGNORE_CASE)
    assertTrue(byKind(mins, "action").any { dueByFriday.containsMatchIn(it.content) })
  }

  @Test fun capturesOpenQuestions() {
    val mins = MinutesExtractor.extract(transcript, speakers)
    assertTrue(byKind(mins, "question").size >= 2)
  }

  @Test fun deduplicatesRepeatedActionItems() {
    val mins = MinutesExtractor.extract(transcript, speakers)
    val actions = byKind(mins, "action").map { it.content }
    assertEquals(actions.size, actions.toSet().size)
  }

  // --- extra sanity cases --------------------------------------------------------------------

  @Test fun decisionDetection_standaloneSentence() {
    val mins = MinutesExtractor.extract(
      listOf(Utt("The decision is final: we ship on Monday.", "s1")),
      speakers,
    )
    val decisions = byKind(mins, "decision")
    assertEquals(1, decisions.size)
    assertEquals("The decision is final: we ship on Monday.", decisions[0].content)
  }

  @Test fun actionWithNamedOwnerAndDueDate() {
    // Note: "Priya will prepare the demo script by next week." (from the mirrored transcript
    // above) is deliberately NOT used here — verified against the real minutes.ts (via a
    // scratch ts-node run) that sentence trips none of ACTION_FIRST_PERSON / ACTION_ASSIGN /
    // ACTION_OBLIGATION / startsWithImperative, so isAction() is false and it's dropped
    // entirely; "will prepare" isn't among the ACTION_OBLIGATION verbs (only will send/get/do
    // are). "should" IS a generic ACTION_OBLIGATION trigger and a NAMED_OWNER trigger word, so
    // it exercises both named-owner and due-date detection together.
    val mins = MinutesExtractor.extract(
      listOf(Utt("Priya should send the report by next week.", "s2")),
      speakers,
    )
    val actions = byKind(mins, "action")
    assertEquals(1, actions.size)
    assertEquals(
      "Priya should send the report by next week. — Priya (due next week)",
      actions[0].content,
    )
  }

  @Test fun questionDetection_withoutQuestionMark() {
    val mins = MinutesExtractor.extract(
      listOf(Utt("How should we proceed with this rollout.", "s1")),
      speakers,
    )
    val questions = byKind(mins, "question")
    assertEquals(1, questions.size)
    assertEquals("How should we proceed with this rollout.", questions[0].content)
  }

  @Test fun summaryLeadsAndOrderIsDecisionsThenActionsThenQuestions() {
    val mins = MinutesExtractor.extract(
      listOf(
        Utt("We decided to go with the new logo.", "s1"),
        Utt("I will send the report tomorrow.", "s1"),
        Utt("What is the timeline?", "s1"),
      ),
      speakers,
    )
    assertEquals(4, mins.size)
    assertEquals("summary", mins[0].kind)
    assertEquals("1 action item, 1 decision, 1 open question.", mins[0].content)
    assertEquals("decision", mins[1].kind)
    assertEquals("action", mins[2].kind)
    assertEquals("question", mins[3].kind)
  }

  @Test fun dedupIgnoresCaseAndPunctuationViaNorm() {
    val mins = MinutesExtractor.extract(
      listOf(
        Utt("We decided to go with Plan A.", "s1"),
        Utt("we decided to go with Plan A!", "s1"), // same after norm() -> deduped
      ),
      speakers,
    )
    val decisions = byKind(mins, "decision")
    assertEquals(1, decisions.size)
    assertEquals("We decided to go with Plan A.", decisions[0].content) // first occurrence wins
  }

  @Test fun capsActionsAtThirty() {
    val utterances = (1..35).map { i -> Utt("I will send update number $i today.", "s1") }
    val mins = MinutesExtractor.extract(utterances, speakers)
    val actions = byKind(mins, "action")
    assertEquals(30, actions.size)
    assertTrue(mins[0].content.startsWith("30 action items"))
  }

  @Test fun namedOwnerExclusionForSentenceInitialCommonCapitalizedWords() {
    // NAMED_OWNER superficially matches "This will", but "This" is on the exclusion list, so
    // owner resolution must fall through to Unassigned rather than reporting "This" as a name.
    val mins = MinutesExtractor.extract(
      listOf(Utt("This will need to be fixed by Friday.", "s1")),
      speakers,
    )
    val actions = byKind(mins, "action")
    assertEquals(1, actions.size)
    assertEquals(
      "This will need to be fixed by Friday. — Unassigned (due by Friday)",
      actions[0].content,
    )
  }
}
