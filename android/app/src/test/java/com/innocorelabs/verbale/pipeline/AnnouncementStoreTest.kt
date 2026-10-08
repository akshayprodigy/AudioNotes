package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** D04: what the service stores for a verdict. That the SQL writes the column is device-only. */
class AnnouncementStoreTest {
  private fun verdict(heard: Boolean, found: Boolean, lagFrames: Int = 35) =
    AnnouncementVerifier.Verdict(heard, found, peakOverBackground = 9f, loudnessRatio = 1f, lagFrames = lagFrames)

  @Test fun foundAndHeardStoresTheLagAndStamps() {
    val p = AnnouncementStore.plan(verdict(heard = true, found = true))
    assertEquals(350L, p.lagMs)
    assertTrue(p.stampHeard)
  }

  @Test fun foundButNotHeardStoresTheLagAndDoesNotStamp() {
    val p = AnnouncementStore.plan(verdict(heard = false, found = true))
    assertEquals(350L, p.lagMs)
    assertFalse(p.stampHeard)
  }

  @Test fun notFoundStoresNothingAndDoesNotStamp() {
    val p = AnnouncementStore.plan(verdict(heard = false, found = false))
    assertNull(p.lagMs)
    assertFalse(p.stampHeard)
  }

  @Test fun theLagIsWrittenOnceWhenThereIsOneAndNeverWhenThereIsNot() {
    val written = ArrayList<Long>()
    AnnouncementStore.applyLag(AnnouncementStore.plan(verdict(heard = false, found = true, lagFrames = 120))) { written.add(it) }
    assertEquals(listOf(1200L), written)
    written.clear()
    AnnouncementStore.applyLag(AnnouncementStore.plan(verdict(heard = false, found = false))) { written.add(it) }
    assertTrue(written.isEmpty())
  }

  @Test fun theLagIsInMillisecondsFromTenMillisecondFrames() {
    assertEquals(0L, AnnouncementStore.plan(verdict(heard = true, found = true, lagFrames = 0)).lagMs)
  }

  // A dictation is one person's own voice. The clip played into it and took the first seconds of what
  // they said (Nothing A069: "Call Priya at five o'clock tomorrow and send her the budget." became
  // "And punch it.").
  @Test fun aMeetingIsAnnouncedButADictationNeverIs() {
    assertEquals(true, AnnouncementStore.announces(resumed = false, mode = null))
    assertEquals(false, AnnouncementStore.announces(resumed = false, mode = "dictation"))
  }

  @Test fun aResumedCaptureIsNeverAnnouncedAgain() {
    assertEquals(false, AnnouncementStore.announces(resumed = true, mode = null))
    assertEquals(false, AnnouncementStore.announces(resumed = true, mode = "dictation"))
  }
}
