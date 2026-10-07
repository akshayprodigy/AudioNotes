package com.innocorelabs.verbale.pipeline

import java.util.Locale
import java.util.TimeZone

/**
 * A meeting's starting title, as a pure function so a JVM test can pin the clock and the locale
 * ([CaptureController] cannot be loaded off a device).
 *
 * A dictation is "Afternoon dictation · …" — it used to say "meeting", because the title was
 * written before the mode was known. [ProcessingEngine.isGeneratedTitle] and the JS
 * `shouldAutoRetitle` must recognise whatever this writes, or the retitle from the opening words
 * never runs for that kind of recording.
 */
object DefaultTitle {
  fun of(createdAt: Long, mode: String?, zone: TimeZone, locale: Locale): String {
    val cal = java.util.Calendar.getInstance(zone).apply { timeInMillis = createdAt }
    val part = when (cal.get(java.util.Calendar.HOUR_OF_DAY)) {
      in 5..11 -> "Morning"
      in 12..16 -> "Afternoon"
      in 17..20 -> "Evening"
      else -> "Late"
    }
    val stamp = java.text.SimpleDateFormat("EEE d MMM, HH:mm", locale)
      .apply { timeZone = zone }
      .format(java.util.Date(createdAt))
    val noun = if (mode == "dictation") "dictation" else "meeting"
    return "$part $noun · $stamp"
  }
}
