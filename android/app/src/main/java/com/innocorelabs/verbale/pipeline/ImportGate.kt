package com.innocorelabs.verbale.pipeline

/**
 * One session at a time (addendum R5, GAP-11): an import and a recording never overlap, and two
 * imports never overlap. Both halves of the rule live here so that they can be tested without a
 * phone: [enter] is the import side, [blocksStart] is what `CaptureController.start` reads.
 *
 * The lock only covers the import side's check-and-set; a recording that starts in the same
 * instant as an import can still slip past the other's check, and that window is a few
 * microseconds wide.
 */
object ImportGate {
  enum class Refusal(val code: String, val message: String) {
    RECORDING_IN_PROGRESS("recording_in_progress", "Finish recording first"),
    IMPORT_IN_PROGRESS("import_in_progress", "Finish the import first"),
  }

  private val lock = Any()

  @Volatile var running: Boolean = false
    private set

  /** True while an import holds the gate: a recording must not start. */
  val blocksStart: Boolean get() = running

  /** Take the gate for one import, or say why not. [recording] is `CaptureController.isRecording`. */
  fun enter(recording: Boolean): Refusal? = synchronized(lock) {
    when {
      recording -> Refusal.RECORDING_IN_PROGRESS
      running -> Refusal.IMPORT_IN_PROGRESS
      else -> {
        running = true
        null
      }
    }
  }

  fun exit() = synchronized(lock) { running = false }
}
