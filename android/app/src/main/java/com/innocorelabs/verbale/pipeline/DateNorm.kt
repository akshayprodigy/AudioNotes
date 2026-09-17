package com.innocorelabs.verbale.pipeline

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * A spoken date phrase resolved against the meeting's date, or honestly null.
 *
 * A rule, never the model: "Friday" said on a Wednesday is the coming Friday, and that is
 * arithmetic. "Next week", "soon", "another week" have no day in them, and a guess shown as a
 * date is the one thing the record must never do — `date_said` keeps the phrase, `date_norm`
 * stays null, and the item goes to the review queue for a person to pin. Mirrored in
 * src/pipeline/dateNorm.ts; cpp/tests/golden/date_norm.json is the contract between the two.
 */
object DateNorm {
  private val weekdays = mapOf(
    "monday" to DayOfWeek.MONDAY, "tuesday" to DayOfWeek.TUESDAY, "wednesday" to DayOfWeek.WEDNESDAY,
    "thursday" to DayOfWeek.THURSDAY, "friday" to DayOfWeek.FRIDAY, "saturday" to DayOfWeek.SATURDAY,
    "sunday" to DayOfWeek.SUNDAY,
  )
  private val numbers = mapOf(
    "one" to 1, "a" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5,
    "six" to 6, "seven" to 7, "eight" to 8, "nine" to 9, "ten" to 10,
  )

  /** The resolved local day as YYYY-MM-DD, or null. The shape the golden table compares. */
  fun resolveDay(said: String, meetingAtMs: Long, zone: ZoneId): String? {
    val today = Instant.ofEpochMilli(meetingAtMs).atZone(zone).toLocalDate()
    return resolveDate(said, today)?.toString()
  }

  /**
   * The resolved calendar day as epoch ms, or null. What `items.date_norm` stores.
   *
   * UTC midnight of the LOCAL calendar day, on purpose: a day is a day, not a moment. Stored as
   * local midnight it would read as the day before to anyone west of the meeting, and the
   * screen's label (recordLabels.ts) reads it back in UTC for the same reason.
   */
  fun resolve(said: String, meetingAtMs: Long, zone: ZoneId): Long? {
    val today = Instant.ofEpochMilli(meetingAtMs).atZone(zone).toLocalDate()
    return resolveDate(said, today)?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli()
  }

  /**
   * The date phrase in a statement, as spoken — "Friday", "by the 3rd", "on Thursday",
   * "tomorrow", "in two weeks", "next week" — or null. The first one in the text, with its
   * preposition, in the statement's own casing, so it is verbatim by construction and resolves
   * through [resolveDate] exactly as the model's phrase would. A rule, because a 1.5B model was
   * measured leaving this empty for "Can you send the proposal Friday?"; the model's phrase is
   * only consulted where this finds nothing.
   */
  fun spanIn(text: String): String? = SPAN.find(text)?.value?.trim()?.ifEmpty { null }

  private const val PREP = "(?:\\b(?:by|on|for|until|till|before)\\s+)?"
  private const val WEEKDAY = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)"
  private val SPAN = Regex(
    listOf(
      "$PREP(?:next|this|coming)\\s+$WEEKDAY\\b(?!'s)",
      "$PREP\\b$WEEKDAY\\b(?!'s)",
      "$PREP(?:the\\s+)?\\b\\d{1,2}(?:st|nd|rd|th)\\b",
      "(?:\\bby\\s+)?(?:the\\s+)?\\bend of (?:the )?(?:week|day|month)\\b",
      "\\bin (?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|\\d+) (?:days?|weeks?)\\b",
      "\\bnext (?:week|month)\\b",
      "$PREP\\b(?:today|tonight|tomorrow)\\b",
    ).joinToString("|"),
    RegexOption.IGNORE_CASE,
  )

  fun resolveDate(said: String, today: LocalDate): LocalDate? {
    // Whole phrase, lower case, punctuation gone, leading "by"/"on"/"for" dropped.
    val words = said.lowercase().replace(Regex("[^a-z0-9 ]"), " ").trim().split(Regex("\\s+"))
      .filter { it.isNotEmpty() }
      .let { if (it.isNotEmpty() && it.first() in setOf("by", "on", "for", "until", "till")) it.drop(1) else it }
    if (words.isEmpty()) return null
    val phrase = words.joinToString(" ")

    when (phrase) {
      "today" -> return today
      "tomorrow" -> return today.plusDays(1)
      "end of the week", "end of week", "the end of the week" -> return nextOrToday(today, DayOfWeek.FRIDAY)
    }
    // "next friday": the one after the coming one. "this friday" / "friday": the coming one.
    if (words.size == 2 && words[0] == "next" && words[1] in weekdays) return nextAfterComing(today, weekdays.getValue(words[1]))
    if (words.size == 2 && words[0] == "this" && words[1] in weekdays) return coming(today, weekdays.getValue(words[1]))
    if (words.size == 1 && words[0] in weekdays) return coming(today, weekdays.getValue(words[0]))
    // "the 21st" / "the 3rd": this month, or next if it has passed — and "the 16th" said ON the
    // 16th is next month's: nobody names today's date as a deadline.
    val ordinal = Regex("^(?:the )?([0-9]{1,2})(?:st|nd|rd|th)$").find(phrase)
    if (ordinal != null) {
      val day = ordinal.groupValues[1].toInt()
      if (day in 1..31) {
        val thisMonth = runCatching { today.withDayOfMonth(day) }.getOrNull()
        return if (thisMonth != null && thisMonth.isAfter(today)) thisMonth
        else runCatching { today.plusMonths(1).withDayOfMonth(day) }.getOrNull()
      }
    }
    // "in two weeks" / "in 3 days".
    val inN = Regex("^in ([a-z0-9]+) (day|days|week|weeks)$").find(phrase)
    if (inN != null) {
      val n = inN.groupValues[1].toIntOrNull() ?: numbers[inN.groupValues[1]] ?: return null
      return if (inN.groupValues[2].startsWith("week")) today.plusWeeks(n.toLong()) else today.plusDays(n.toLong())
    }
    return null
  }

  /** The first such weekday strictly after today; the same weekday means a week later. */
  private fun coming(today: LocalDate, day: DayOfWeek): LocalDate {
    var d = today.plusDays(1)
    while (d.dayOfWeek != day) d = d.plusDays(1)
    return d
  }

  private fun nextAfterComing(today: LocalDate, day: DayOfWeek): LocalDate = coming(today, day).plusWeeks(1)

  private fun nextOrToday(today: LocalDate, day: DayOfWeek): LocalDate =
    if (today.dayOfWeek == day) today else coming(today, day)
}
