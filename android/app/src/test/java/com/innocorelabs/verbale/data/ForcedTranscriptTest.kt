package com.innocorelabs.verbale.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The two columns behind "Transcribe it anyway", checked without a device.
 *
 * `forced_from_language` is the one that fails silently: ProcessingEngine sets `language` to what
 * was HEARD on the refusal path and to what was REQUESTED on success, so a forced run overwrites
 * the heard code with "en" and the banner loses its claim. Nothing breaks — the banner just goes
 * quiet, which is exactly why it is pinned here rather than left to be noticed.
 */
class ForcedTranscriptTest {

  @Test
  fun forced_columns_are_declared_in_the_migration_list() {
    val added = AudioDb.addedColumnsForTest()
    assertEquals(
      "INTEGER",
      added.firstOrNull { it.first == "meetings" && it.second == "transcribe_forced_at" }?.third,
    )
    assertEquals(
      "TEXT",
      added.firstOrNull { it.first == "meetings" && it.second == "forced_from_language" }?.third,
    )
  }

  @Test
  fun a_meeting_that_was_never_forced_has_no_marker() {
    assertNull(forcedBannerLanguage(transcribeForcedAt = null, forcedFromLanguage = "tr"))
  }

  @Test
  fun a_forced_meeting_reports_the_language_it_was_forced_from() {
    assertEquals(
      "tr",
      forcedBannerLanguage(transcribeForcedAt = 1_725_000_000_000L, forcedFromLanguage = "tr"),
    )
  }

  @Test
  fun a_forced_meeting_with_no_heard_language_still_reports_that_it_was_forced() {
    assertEquals(
      "",
      forcedBannerLanguage(transcribeForcedAt = 1_725_000_000_000L, forcedFromLanguage = null),
    )
  }
}

/**
 * Null when the meeting was never forced; otherwise the language code it was forced from, or ""
 * when detection never named one.
 *
 * A free function so the rule is testable without opening an encrypted database. The distinction
 * that matters is null (never forced, show nothing) against "" (forced, but we cannot say what we
 * heard) — collapsing those two would silence the warning on exactly the recordings where
 * detection was least sure.
 */
fun forcedBannerLanguage(transcribeForcedAt: Long?, forcedFromLanguage: String?): String? =
  if (transcribeForcedAt == null) null else (forcedFromLanguage ?: "")
