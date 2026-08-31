package com.innocorelabs.verbale.pipeline

import android.content.Context
import android.util.Log
import com.innocorelabs.verbale.data.AudioDb
import java.io.File

/**
 * How long a recording is kept after it has been transcribed, and the sweep that enforces it.
 *
 * The window lives natively because the promise does. Recording from the Quick Settings tile or
 * the PiP window never starts a JS context, so a sweep that only ran in JS would quietly make
 * "kept for 7 days" false for the person who records for a month without opening the app — every
 * minute of unencrypted PCM still on disk. JS calls in on app open as a catch-up; this is the
 * authority.
 */
object AudioRetention {
  private const val TAG = "AudioRetention"

  /**
   * The window a fresh install gets. Mirrors DEFAULT_RETENTION_DAYS in
   * src/pipeline/PipelineController.ts and RETENTION_DEFAULT_DAYS in SettingsScreen.
   */
  const val DEFAULT_DAYS = 7

  /** The real setting, in days. -1 keeps audio until the meeting is deleted, 0 deletes at once. */
  const val KEY_DAYS = "audioRetentionDays"

  /** The boolean this replaced. Still read, because installs exist whose only opinion is this one. */
  const val KEY_LEGACY = "keepAudio"

  /**
   * Resolve the window from the two settings keys.
   *
   * Kept a deliberate mirror of resolveRetentionDays() in src/pipeline/PipelineController.ts. The
   * two sides must agree exactly: JS decides what the Settings screen SAYS is happening to the
   * audio, and this decides what actually happens to it. A disagreement deletes a recording the
   * user has just been told is still there.
   *
   * A malformed value falls through to the legacy default rather than being read as 0, because 0
   * means "delete everything that has a transcript, now" and that is not an outcome any typo
   * should be able to produce.
   */
  fun resolveDays(audioRetentionDays: String?, keepAudio: String?): Int {
    val raw = audioRetentionDays?.trim().orEmpty()
    if (raw.isNotEmpty()) {
      val n = raw.toIntOrNull()
      if (n != null) return if (n < 0) -1 else n
    }
    return if (keepAudio == "1") -1 else DEFAULT_DAYS
  }

  fun daysFor(db: AudioDb): Int = resolveDays(db.getSetting(KEY_DAYS), db.getSetting(KEY_LEGACY))

  /**
   * Delete audio for every meeting past its window, and report how many were swept.
   *
   * [excludeId] is the meeting being recorded right now: its file is open and still being written,
   * and its `created_at` is already in the past, so a zero-day window would otherwise sweep the
   * recording out from under RecordingService mid-meeting.
   *
   * Best-effort throughout. A file that will not delete is logged and skipped rather than failing
   * the sweep — the next one tries again — and the retained flag is only cleared once the file is
   * actually gone, so a failure does not leave the UI claiming audio was reclaimed when it was not.
   */
  fun sweep(ctx: Context, excludeId: String?): Int {
    val db = AudioDb.get(ctx)
    val days = daysFor(db)
    if (days < 0) return 0 // "keep until I delete it" — nothing is ever past its window

    var swept = 0
    for ((id, path) in db.audioOlderThan(days, excludeId)) {
      val f = File(path)
      if (f.exists() && !f.delete()) {
        Log.w(TAG, "could not delete audio for $id")
        continue
      }
      db.setAudioRetained(id, false)
      swept++
    }
    if (swept > 0) Log.i(TAG, "swept audio for $swept meeting(s) past the $days-day window")
    return swept
  }
}
