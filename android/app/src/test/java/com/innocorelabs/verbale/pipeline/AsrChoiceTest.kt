package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Which whisper a meeting is written down with. Pro is sold as the larger transcriber, and until
 * this existed every meeting — paid or not — went through whisper-base, because the one caller
 * (ProcessingService) passed the literal "base".
 */
class AsrChoiceTest {

  @Test
  fun `a subscriber with whisper-small on the phone gets small`() {
    assertEquals("small", AsrChoice.model(entitled = true, smallInstalled = true))
  }

  @Test
  fun `a subscriber whose download has not finished still gets a transcript, from base`() {
    assertEquals("base", AsrChoice.model(entitled = true, smallInstalled = false))
  }

  /** Lapsed Pro keeps the file (it is their storage) but not the model: base is the free floor. */
  @Test
  fun `a lapsed subscriber with the file still on disk gets base`() {
    assertEquals("base", AsrChoice.model(entitled = false, smallInstalled = true))
  }

  @Test
  fun `free gets base`() {
    assertEquals("base", AsrChoice.model(entitled = false, smallInstalled = false))
  }
}
