package com.innocorelabs.verbale.pipeline

/**
 * Who may send a file out of the app.
 *
 * EVERY FILE EXPORT IS PRO — MP3, PDF, SRT, Markdown, text. Copying to the clipboard (`render`,
 * `copy`) and the share preview are not exports: nothing leaves the app, and seeing what you would
 * get is the point of the Free flow. So the Share screen still opens for a Free person; only the
 * act of sharing is refused.
 *
 * The gate is NATIVE and sits in front of the work, so a bug in a screen cannot hand a file to a
 * Free user. It is a pure function of (operation, format, paid) so a JVM test can hold it to every
 * format; the module supplies `paid` from the same licence check the rest of the app uses.
 *
 * It fails CLOSED: it keys on the OPERATION, not on a list of formats, so a format it has not heard
 * of is gated too — "unknown, therefore free" is the hole a new format would walk through.
 */
object ExportGate {
  /** The rejection code the Share screen turns into the Pro sheet. */
  const val PRO_REQUIRED = "PRO_REQUIRED"

  /** Operations that put a file in the share sheet. */
  private val FILE_OPS = setOf("share", "shareWith", "exportMp3")

  /** Null when allowed, otherwise the rejection code. */
  fun refusal(op: String, format: String, paid: Boolean): String? {
    if (paid) return null
    if (op in FILE_OPS) return PRO_REQUIRED
    return null
  }
}
