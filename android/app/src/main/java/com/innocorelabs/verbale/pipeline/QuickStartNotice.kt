package com.innocorelabs.verbale.pipeline

/**
 * What the Quick Settings tile says when it will not start a recording because the month's Free
 * meetings are spent. The tile used to open the app and say nothing: the Library carries only a
 * small grey count line, and a person who tapped "record" got a list (Nothing A069, 8 Oct).
 * Same wording as the Record screen's hint, so the two never disagree.
 */
object QuickStartNotice {
  private val MONTHS = arrayOf(
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  )

  /** [resetsOn] is `YYYY-MM-DD`; anything else is shown as it came rather than guessed at. */
  fun exhausted(resetsOn: String): String {
    val parts = resetsOn.split("-")
    val month = parts.getOrNull(1)?.toIntOrNull()
    val day = parts.getOrNull(2)?.toIntOrNull()
    val date = if (parts.size == 3 && month in 1..12 && day in 1..31) "$day ${MONTHS[month!! - 1]}" else resetsOn
    return "Free meetings are used up until $date"
  }
}
