package com.innocorelabs.verbale.pipeline

import android.content.Context
import android.util.Log

/**
 * The one Stop: end the capture, then queue the meeting for processing so a Stop from anywhere
 * produces a finished MOM headlessly. The notification's Stop ([RecordingService]), the PiP
 * button ([PipActionReceiver]) and the Quick Settings tile ([RecordTileService]) each carried
 * their own copy of "stop, and if it returned an id, enqueue inside a try"; they now all call
 * [run], so the three cannot drift (D24, §1.2).
 *
 * Blocks for up to the flush in `CaptureController.stop` — never on the main thread.
 *
 * Failure rules, each held by StopAndQueueTest:
 *  - `stop` returns null (nothing was recording) or throws: nothing is queued, no id comes back;
 *  - `enqueue` throws (Android refuses a background foreground-service start): the meeting is
 *    already 'captured', so it is left for the Library sweep, the failure is logged by name, and
 *    [Outcome.leftForSweep] says so. It never propagates: a rejected start must not crash the
 *    receiver, the tile or the service that called this.
 *
 * Whether Android accepts the background enqueue is device-only (D24).
 */
object StopAndQueue {
  private const val TAG = "StopAndQueue"

  class Deps(
    val stop: () -> String?,
    val enqueue: (String) -> Unit,
    val log: (String, Throwable?) -> Unit = { m, e -> Log.w(TAG, m, e) },
  )

  data class Outcome(val meetingId: String?, val queued: Boolean, val leftForSweep: Boolean)

  fun run(deps: Deps): Outcome {
    val id = try {
      deps.stop()
    } catch (e: Exception) {
      deps.log("stop failed", e)
      null
    } ?: return Outcome(null, queued = false, leftForSweep = false)
    return try {
      deps.enqueue(id)
      Outcome(id, queued = true, leftForSweep = false)
    } catch (e: Exception) {
      deps.log("could not queue $id after Stop — left captured for the Library sweep", e)
      Outcome(id, queued = false, leftForSweep = true)
    }
  }

  /** The production wiring every Stop surface calls. */
  fun run(context: Context): Outcome {
    val app = context.applicationContext
    return run(Deps(stop = { CaptureController.stop(app) }, enqueue = { ProcessingService.enqueue(app, it) }))
  }
}
