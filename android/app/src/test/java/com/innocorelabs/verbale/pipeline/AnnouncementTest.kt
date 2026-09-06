package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the app is allowed to claim about the announcement.
 *
 * The feature exists to let a recording prove the room was told. An app that reported "told"
 * because it TRIED to tell them would be worse than one with no announcement at all: the person
 * would stop checking, which is the one behaviour this is supposed to produce.
 */
class AnnouncementTest {

  @Test
  fun a_finished_announcement_counts() {
    assertTrue(AnnouncementPlayer.Outcome.PLAYED.wasHeard())
  }

  @Test
  fun a_silenced_or_failed_announcement_does_not_count() {
    assertFalse(AnnouncementPlayer.Outcome.FAILED.wasHeard())
    assertFalse(AnnouncementPlayer.Outcome.NO_CLIP.wasHeard())
    assertFalse(AnnouncementPlayer.Outcome.SILENCED.wasHeard())
  }

  @Test
  fun switched_off_is_not_a_failure_and_still_does_not_count() {
    // Somebody who turned it off and announced it themselves has not failed at anything. The
    // meeting still carries no evidence, so it must not be stamped either.
    assertFalse(AnnouncementPlayer.Outcome.DISABLED.wasHeard())
  }

  @Test
  fun every_outcome_has_a_reason_a_person_could_act_on() {
    // A failure the user cannot interpret is a failure they will ignore. SILENCED and NO_CLIP
    // have different remedies, so they must not collapse into one message.
    val messages = AnnouncementPlayer.Outcome.values()
      .filter { !it.wasHeard() && it != AnnouncementPlayer.Outcome.DISABLED }
      .map { it.userMessage() }
    assertTrue("each failure needs its own wording", messages.toSet().size == messages.size)
    assertTrue("no failure may be silent", messages.none { it.isBlank() })
  }
}
