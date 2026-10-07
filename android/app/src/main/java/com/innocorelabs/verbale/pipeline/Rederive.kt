package com.innocorelabs.verbale.pipeline

import android.content.Context
import android.util.Log
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.Corrections

/**
 * Re-run the rule pass over one meeting's CURRENT transcript (F15).
 *
 * A transcript correction is written through into `utterances.text`; this is what makes the items
 * follow it. It is exactly the minutes stage of [ProcessingEngine] — `Minutes.extract`,
 * `Minutes.extractItems`, then the same persistence — without the audio, the models or any of the
 * other stages, so it costs milliseconds and can run on a screen.
 *
 * What it keeps is not decided here: the items go through `AudioDb.replaceItems` and the
 * [Reconciler], which carry a tick, a hand correction and a hand-typed item across and re-match an
 * item whose wording changed by its time anchor and text. What it does NOT do: narration (the
 * summary is marked stale instead — `Corrections.narrationStale`) and the Pro classifier (a
 * re-extracted item arrives unclassified, which is what the classifier's own sweep looks for).
 *
 * WHILE A RUN IS IN FLIGHT it does nothing and says so: the meeting's status is not a finished one,
 * the engine's own minutes stage reads the corrected lines, and the pending flag makes the next
 * open of the meeting re-derive once more in case that stage had already passed. A failure to load
 * the core leaves the same flag.
 */
object Rederive {
  private const val TAG = "Rederive"

  /** @return true when the rule pass ran and the derived pieces were rewritten. */
  fun run(ctx: Context, db: AudioDb, meetingId: String): Boolean {
    if (!Corrections.rederiveNow(db.meetingStatus(meetingId))) {
      db.setRederivePending(meetingId, true)
      return false
    }
    return try {
      NativeBridge.ensureLoaded(ctx)
      val utts = db.utterances(meetingId)
      // replaceItems handed an empty list deletes every item, and a meeting can have items and no
      // transcript (hand-typed ones), so no transcript means nothing to re-derive from.
      if (utts.isEmpty()) {
        db.setRederivePending(meetingId, false)
        return false
      }
      val speakers = db.speakers(meetingId)
      db.rederiveWrite(meetingId, Minutes.extract(utts, speakers), Minutes.extractItems(utts, speakers))
      db.setRederivePending(meetingId, false)
      true
    } catch (e: Throwable) {
      Log.w(TAG, "re-derive failed for $meetingId; will retry on next open", e)
      db.setRederivePending(meetingId, true)
      false
    }
  }

  /** Called on every open of a meeting: corrections from before write-through, then a deferred re-derive. */
  fun catchUp(ctx: Context, db: AudioDb, meetingId: String) {
    if (db.writeThroughSavedCorrections(meetingId) > 0) db.setRederivePending(meetingId, true)
    if (db.rederivePending(meetingId)) run(ctx, db, meetingId)
  }
}
