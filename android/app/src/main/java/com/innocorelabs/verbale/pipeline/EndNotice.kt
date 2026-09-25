package com.innocorelabs.verbale.pipeline

/**
 * How a recording ended, decided in one place: what the meeting stores, whether the service sends
 * it for processing itself, and what the notification says. Pure, so EndNoticeTest can hold every
 * reason. A Stop — screen, notification, PiP or tile — is queued by whoever pressed it.
 */
object EndNotice {
  data class Notice(val title: String, val body: String)

  /** The meeting row's end_reason. */
  fun stored(reason: String): String =
    if (reason == RecordingService.END_NORMAL) "stopped" else reason

  fun shouldProcess(reason: String, capturedBytes: Long): Boolean =
    reason != RecordingService.END_NORMAL && capturedBytes > 0L

  /** Null for a Stop. [processing] is whether the queueing went through. */
  fun of(reason: String, capturedBytes: Long, processing: Boolean, capMinutes: Int): Notice? {
    if (reason == RecordingService.END_NORMAL) return null
    if (capturedBytes <= 0L) {
      return if (reason == RecordingService.END_DISK_FULL) {
        Notice("Could not start recording", "The phone is out of space. Free some up and try again. Nothing was recorded.")
      } else {
        Notice("Could not start recording", "The microphone could not be opened — another app may be using it. Nothing was recorded.")
      }
    }
    val next = if (processing) "It is being transcribed now." else "Open Verbale to transcribe it."
    return when (reason) {
      RecordingService.END_CAP_REACHED ->
        Notice("Stopped at the $capMinutes-minute Free limit", "The recording is kept. $next Pro records without a limit.")
      RecordingService.END_MIC_LOST ->
        Notice("Recording stopped: the microphone was taken", "A call or another app took the microphone. What was recorded is kept. $next")
      RecordingService.END_DISK_FULL ->
        Notice("Recording stopped: the phone is out of space", "What was recorded is kept. $next")
      else ->
        Notice("Recording stopped: the audio could not be saved", "What was recorded is kept. $next")
    }
  }
}
