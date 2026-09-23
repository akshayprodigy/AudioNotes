package com.innocorelabs.verbale.billing

import android.content.Context
import android.util.Log
import com.innocorelabs.verbale.data.AudioDb
import kotlin.math.max
import kotlin.math.min

/**
 * The free trial of Pro, on the side that actually enforces it.
 *
 * A deliberate mirror of src/billing/trial.ts, and it has to exist here rather than only there for
 * the same reason the paid gate does: narration runs natively, in a foreground service, for
 * meetings the JS context never sees — a recording stopped from the PiP window or the notification
 * is processed to finished minutes with no React alive. A trial that only JS understood would
 * grant a person nothing at all, and would never count what it had granted.
 *
 * **Retired as a product, 23 Sep 2026.** Customers now get Play's seven-day free trial, which the
 * licence server turns into an ordinary paid licence. Nothing in the app starts this trial any
 * more, and LicenceStore.entitled consults it only in a DEBUG build — where the device tests
 * (NativePipelineTest, PeopleDbTest, ThreadsDbTest, VerificationTrialTest) write its keys to get
 * Pro without a purchase.
 *
 * The two sides share the settings rows rather than a rule engine: JS starts the trial and decides
 * what the screens say, this decides whether the model may run and counts what it wrote. Both read
 * the same three keys, so neither can drift into a different answer about whether the trial is
 * over. If [DAYS] or [SUMMARIES] changes, it changes in trial.ts in the same commit.
 */
object Trial {
  private const val TAG = "Trial"

  /** Mirrors TRIAL_DAYS / TRIAL_SUMMARIES in src/billing/trial.ts. */
  const val DAYS = 7
  const val SUMMARIES = 3

  private const val DAY_SECONDS = 24L * 60L * 60L

  // BackupManager.LOCAL_SETTINGS strips exactly these names from an export, which is what stops
  // "back up, burn the trial, restore" from resetting the counter forever. Renaming one here
  // without renaming it there silently re-opens that hole.
  private const val KEY_STARTED = "trial_started_at"
  private const val KEY_USED = "trial_summaries_used"
  private const val KEY_ENDED = "trial_ended_at"

  private fun int(v: String?): Long {
    val n = v?.trim()?.toLongOrNull() ?: return 0L
    return if (n > 0) n else 0L
  }

  /**
   * Is the trial running right now?
   *
   * Both limits are checked, whichever runs out first. Reading the monotonic clock rather than the
   * system one is the whole defence: a time window enforced against a clock the user can wind back
   * is not a window at all.
   */
  fun isActive(ctx: Context): Boolean {
    return try {
      val db = AudioDb.get(ctx)
      val started = int(db.getSetting(KEY_STARTED))
      if (started == 0L) return false            // never started
      if (int(db.getSetting(KEY_ENDED)) > 0L) return false  // already written off
      if (int(db.getSetting(KEY_USED)) >= SUMMARIES) return false

      val now = LicenceStore.now(ctx)
      // A start stamp in the future means the floor moved under us — a corrected clock, or a
      // licence refresh landing between two reads. Clamping can only ever shorten the window.
      val from = min(started, now)
      now < from + DAYS * DAY_SECONDS
    } catch (e: Throwable) {
      // A settings read that fails must not hand out a trial, and must not fail a transcript.
      Log.w(TAG, "could not read trial state", e)
      false
    }
  }

  /**
   * Count one prose summary against the trial.
   *
   * Called after a summary has actually been written, never before: a model that failed to load,
   * or a run the user cancelled half way, must not cost one of three. A subscriber's summaries
   * never count either — if they later cancel, the trial they never used is still theirs.
   *
   * Ending is written down as well as computed, so the screens and the sweep agree on the moment
   * it ended without re-deriving the rule, and so a clock correction cannot flicker it back to
   * life.
   */
  fun noteSummary(ctx: Context) {
    try {
      if (LicenceStore.current(ctx).isPaid) return
      if (!isActive(ctx)) return

      val db = AudioDb.get(ctx)
      val used = int(db.getSetting(KEY_USED)) + 1
      db.putSetting(KEY_USED, used.toString())

      if (used >= SUMMARIES) {
        val now = LicenceStore.now(ctx)
        val started = int(db.getSetting(KEY_STARTED))
        val expiresAt = min(started, now) + DAYS * DAY_SECONDS
        db.putSetting(KEY_ENDED, max(1L, min(now, expiresAt)).toString())
        Log.i(TAG, "trial ended: all $SUMMARIES summaries used")
      }
    } catch (e: Throwable) {
      Log.w(TAG, "could not count a trial summary", e)
    }
  }
}
