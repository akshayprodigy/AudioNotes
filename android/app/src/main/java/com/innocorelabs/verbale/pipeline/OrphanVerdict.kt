package com.innocorelabs.verbale.pipeline

/**
 * What to do with a meeting found stranded in 'recording' after the process died (N03).
 *
 * The decision `AudioDb.recoverOrphanedRecordings` makes per row, with no database: MORE than a
 * second of PCM (32,000 bytes at 16 kHz mono 16-bit) is a meeting and becomes 'captured', anything
 * smaller is a failed start and becomes 'error', and a row that is not in 'recording' is not
 * touched at all. The SQL around it (the SELECT, markCaptured, setStatus) is device-only.
 */
object OrphanVerdict {
  /** Strictly more than this many bytes is audio worth keeping. */
  const val MIN_BYTES = 32_000L
  /** 16 kHz x 2 bytes per sample = 32 bytes per millisecond. */
  const val BYTES_PER_MS = 32L

  enum class Kind { CAPTURED, ERROR, LEAVE }

  data class Verdict(val kind: Kind, val durationMs: Long = 0L)

  fun of(bytesOnDisk: Long, status: String): Verdict = when {
    status != "recording" -> Verdict(Kind.LEAVE)
    bytesOnDisk > MIN_BYTES -> Verdict(Kind.CAPTURED, bytesOnDisk / BYTES_PER_MS)
    else -> Verdict(Kind.ERROR)
  }
}
