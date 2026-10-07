package com.innocorelabs.verbale.pipeline

import java.util.Locale
import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * F22b (D18): a dictation was auto-titled "Afternoon meeting · …" because the title was written
 * before the mode was known. The default title is now mode-aware, and the retitle guard must still
 * recognise it — otherwise a dictation would keep the placeholder for ever instead of being named
 * from its opening words.
 */
class DefaultTitleTest {
  private val utc = TimeZone.getTimeZone("UTC")

  /** 2026-10-07 at the given UTC hour, in milliseconds. */
  private fun at(hour: Int): Long =
    java.util.GregorianCalendar(utc).apply { clear(); set(2026, java.util.Calendar.OCTOBER, 7, hour, 5) }.timeInMillis

  private fun title(hour: Int, mode: String?) =
    DefaultTitle.of(at(hour), mode, utc, Locale.US)

  @Test fun aMeetingKeepsItsTitle() {
    assertEquals("Afternoon meeting · Wed 7 Oct, 14:05", title(14, null))
    assertEquals("Morning meeting · Wed 7 Oct, 09:05", title(9, "meeting"))
    // An import has no mode, and stays a meeting.
    assertEquals("Late meeting · Wed 7 Oct, 23:05", title(23, null))
  }

  @Test fun aDictationSaysSo() {
    assertEquals("Afternoon dictation · Wed 7 Oct, 14:05", title(14, "dictation"))
    assertEquals("Evening dictation · Wed 7 Oct, 18:05", title(18, "dictation"))
  }

  @Test fun theRetitleGuardRecognisesBothDefaults() {
    assertTrue(ProcessingEngine.isGeneratedTitle("Afternoon meeting · Wed 7 Oct, 14:05"))
    assertTrue(ProcessingEngine.isGeneratedTitle("Afternoon dictation · Wed 7 Oct, 14:05"))
    assertTrue(ProcessingEngine.isGeneratedTitle("Meeting"))
  }

  @Test fun theRetitleGuardLeavesARealTitleAlone() {
    assertFalse(ProcessingEngine.isGeneratedTitle("Pricing call with Acme"))
    assertFalse(ProcessingEngine.isGeneratedTitle("Dictation"))
    assertFalse(ProcessingEngine.isGeneratedTitle("Notes from the dictation"))
  }
}
