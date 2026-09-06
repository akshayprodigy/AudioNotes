package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
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

  // ---- playback finishing is not the room being told ----

  @Test
  fun a_finished_playback_the_recording_did_not_carry_is_not_an_announcement() {
    // The defect this rule exists to remove. Six recordings on a Pixel 7 Pro returned PLAYED
    // identically; the room got the disclosure in two of them.
    assertEquals(
      AnnouncementPlayer.Outcome.NOT_HEARD,
      AnnouncementPlayer.verified(AnnouncementPlayer.Outcome.PLAYED, heardInRecording = false),
    )
    assertFalse(
      AnnouncementPlayer.verified(AnnouncementPlayer.Outcome.PLAYED, false).wasHeard(),
    )
  }

  @Test
  fun a_finished_playback_the_recording_carries_is_the_only_thing_that_stamps() {
    assertTrue(
      AnnouncementPlayer.verified(AnnouncementPlayer.Outcome.PLAYED, heardInRecording = true)
        .wasHeard(),
    )
  }

  @Test
  fun verification_cannot_turn_a_failure_into_a_success() {
    // Whatever the recording happens to contain, a switched-off or silenced announcement stays
    // what it was. Only PLAYED is ever downgraded.
    for (o in listOf(
      AnnouncementPlayer.Outcome.DISABLED,
      AnnouncementPlayer.Outcome.SILENCED,
      AnnouncementPlayer.Outcome.NO_CLIP,
      AnnouncementPlayer.Outcome.FAILED,
    )) {
      assertEquals(o, AnnouncementPlayer.verified(o, heardInRecording = true))
      assertFalse(AnnouncementPlayer.verified(o, true).wasHeard())
    }
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

  @Test
  fun the_announced_column_is_declared_in_the_migration_list() {
    val added = com.innocorelabs.verbale.data.AudioDb.addedColumnsForTest()
    org.junit.Assert.assertEquals(
      "INTEGER",
      added.firstOrNull { it.first == "meetings" && it.second == "announced_at" }?.third,
    )
  }
}
