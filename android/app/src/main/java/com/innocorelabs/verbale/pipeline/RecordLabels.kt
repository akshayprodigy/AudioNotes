package com.innocorelabs.verbale.pipeline

import java.time.Instant
import java.time.ZoneOffset

/**
 * What a typed item wears, in the words a person reads — the mirror of
 * src/screens/meeting/recordLabels.ts, against cpp/tests/golden/record_labels.json.
 *
 * The screen renders the chips in TypeScript; every export is rendered here. Two renderers of
 * the same record are two chances to drift, which is why one golden pins both. "Open" is not a
 * label — it is the absence of one — and an unclassified row (every free-tier row) wears nothing.
 */
object RecordLabels {
  data class Labels(val type: String?, val status: String?, val day: String?)

  private val TYPE = mapOf(
    "proposal" to "Proposal", "agreement" to "Agreement", "commitment" to "Commitment",
    "request" to "Request", "rejection" to "Rejection", "unresolved" to "Unresolved",
    "uncertain" to "Not sure",
  )
  private val STATUS = mapOf("qualified" to "Qualified", "contradicted" to "Contradicted", "withdrawn" to "Withdrawn")

  // Fixed tables, not the platform's formatter: ICU spells September "Sept" in some locales, and
  // a label must read the same in a forwarded document as on the screen it was read from.
  private val WEEKDAY = arrayOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
  private val MONTH = arrayOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

  /** "Fri 18 Sep" for an epoch at UTC midnight — the day date_norm holds, read in the zone it was written in. */
  fun dayLabel(dateNorm: Long): String {
    val d = Instant.ofEpochMilli(dateNorm).atZone(ZoneOffset.UTC).toLocalDate()
    return "${WEEKDAY[d.dayOfWeek.value % 7]} ${d.dayOfMonth} ${MONTH[d.monthValue - 1]}"
  }

  fun labelsFor(itemType: String?, status: String?, dateNorm: Long?): Labels {
    if (itemType.isNullOrEmpty()) return Labels(null, null, null)
    return Labels(
      type = TYPE[itemType] ?: itemType,
      status = status?.let { STATUS[it] },
      day = dateNorm?.let { dayLabel(it) },
    )
  }

  /** The labels as an exported bullet's tail: " · Request · Contradicted · → Fri 18 Sep", or "". */
  fun suffix(itemType: String?, status: String?, dateNorm: Long?): String {
    val l = labelsFor(itemType, status, dateNorm)
    val parts = listOfNotNull(l.type, l.status, l.day?.let { "→ $it" })
    return if (parts.isEmpty()) "" else " · " + parts.joinToString(" · ")
  }
}
