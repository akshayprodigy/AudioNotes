package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.data.AudioDb
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONArray

/**
 * Storage TurboModule — thin delegate over the shared AudioDb (SQLCipher). The typed JS query
 * layer (src/db/queries.ts) calls these. See src/native/NativeStorage.ts for the spec.
 */
class StorageModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "Storage"

  @ReactMethod
  fun open(promise: Promise) {
    try {
      AudioDb.get(ctx)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("db_open", e)
    }
  }

  @ReactMethod
  fun query(sql: String, paramsJson: String, promise: Promise) {
    try {
      promise.resolve(AudioDb.get(ctx).rawQueryJson(sql, parseArgs(paramsJson)))
    } catch (e: Exception) {
      promise.reject("db_query", e)
    }
  }

  @ReactMethod
  fun reindex(meetingId: String, promise: Promise) {
    try {
      AudioDb.get(ctx).reindexMeeting(meetingId)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("db_reindex", e)
    }
  }

  /**
   * Give one meeting its items if it was recorded before items existed.
   *
   * Shaped like [reindex] and per-meeting: a few milliseconds of pure text over stored utterances,
   * on the path that opens a meeting. [backfillItems] below is the same migration driven across the
   * library, and the two are not alternatives — this one is what migrates the meeting somebody
   * opened straight from a notification, before its screen reads it, and it is awaited for that
   * reason. The caller is `MeetingScreen.refresh` in JavaScript, memoised per opening.
   *
   * Task 8's version of this comment said a library-wide sweep "would only add a migration nobody
   * can tell has finished", and that objection was answered rather than ignored: `items_migrated_at`
   * is what a sweep can tell has finished, because "has this meeting got items" cannot be that
   * signal — see [AudioDb.ensureItems].
   */
  @ReactMethod
  fun ensureItems(meetingId: String, promise: Promise) {
    try {
      val db = AudioDb.get(ctx)
      // FIRST, and outside the native load below on purpose — two separate reasons, both about
      // reaching meetings [AudioDb.backfillItems] cannot.
      //
      // [AudioDb.carryUserMinutesOntoItems] moves every decision, action and open question a
      // person TYPED out of `minutes` and into `items`, and [AudioDb.carryEditsOntoItems] moves
      // every hand correction off the minute it was written against and onto the item that
      // replaced it. `backfillItems` does both, in its own transaction, but only for a meeting it
      // is migrating NOW — and it never runs again for a meeting the Task 8b sweep has stamped,
      // nor for one the pipeline wrote items for directly. Those are precisely the meetings
      // likeliest to be carrying typed rows and corrections, and this is the one call every reader
      // of a meeting passes through before reading it.
      //
      // Before `ensureLoaded` because both carries are pure SQL — no rules, no core — and a phone
      // still downloading libonnxruntime.so would otherwise open every meeting with the user's own
      // corrections and their own typed decisions missing from it. Both are idempotent from the
      // data rather than from a marker, so running them on every open costs one indexed lookup and
      // one scan of this meeting's `minutes` — a scan `db.minutes` pays again on the same open.
      //
      // That ordering is also why [AudioDb.ensureItems] and [AudioDb.unmigratedMeetings] ask
      // whether the RULES have produced items rather than whether there are any: the typed-row
      // carry can give an item to a meeting the rules have never run over, and a guard that could
      // not tell the difference would strand it unmigrated forever.
      //
      // The typed-row carry runs FIRST because the correction carry matches an item's TEXT, and a
      // hand-typed row has no item to match until this has run.
      db.carryUserMinutesOntoItems(meetingId)
      db.carryEditsOntoItems(meetingId)
      // The ONLY part of this method that reaches native code. The migration re-runs the rule
      // pass, which lives in libaudionotes.so, and nothing loads that at app start —
      // MainApplication does loadReactNative and no more, and the other four ensureLoaded call
      // sites are all on paths that record or transcribe. So on the path this exists for, a cold
      // start where somebody opens an old meeting without recording anything, the JNI call would
      // throw UnsatisfiedLinkError and the catch below would turn it into a rejected promise and a
      // meeting that silently never migrates.
      //
      // Rejecting is the right answer on a phone that has not finished downloading
      // libonnxruntime.so yet: ensureLoaded fails loudly, and because ensureItems derives "has
      // this been migrated" from the data rather than a flag, the next open simply tries again.
      NativeBridge.ensureLoaded(ctx)
      db.ensureItems(meetingId)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("db_ensure_items", e)
    }
  }

  /**
   * Index meetings recorded before the search index covered anything but the transcript.
   *
   * Chunked, and driven from JS rather than run inside AudioDb.open(): there is one process-wide
   * connection shared with the recording and processing services, and open() is reached on the
   * MAIN thread when a cold start comes from the Quick Settings tile — a full-library index build
   * there would ANR the activity that has to survive long enough to start the recording.
   */
  @ReactMethod
  fun backfillSearch(limit: Double, promise: Promise) {
    try {
      val db = AudioDb.get(ctx)
      for (id in db.unindexedMeetings(limit.toInt())) db.reindexMeeting(id)
      promise.resolve(db.unindexedMeetings(1).size.toDouble())
    } catch (e: Throwable) {
      promise.reject("db_backfill", e)
    }
  }

  /**
   * Migrate meetings recorded before items existed, a batch at a time.
   *
   * The library-wide half of [ensureItems], and the reason both exist is that they serve different
   * readers. Opening a meeting can migrate that meeting; the worklist, the Library's
   * outstanding-actions tally and Search's "meetings with actions" filter all read ACROSS meetings,
   * so under the per-meeting trigger alone they describe the meetings somebody has opened since
   * updating and tell everybody else they have nothing outstanding. Task 8 chose lazy-only and
   * that was wrong — not because it under-covers, but because the three views state a number rather
   * than showing a gap.
   *
   * Chunked and JS-driven for [backfillSearch]'s reasons exactly: one process-wide connection
   * shared with the recording and processing services, and `open()` runs on the MAIN thread when a
   * cold start comes from the Quick Settings tile. `libraryStore.backfillItems` owns the loop, the
   * latch and the retry policy.
   *
   * @param limit meetings to migrate in this call.
   * @return how many are STILL outstanding — a real count, because the loop stops both when it
   *   reaches zero and when a pass fails to shrink it. See [AudioDb.unmigratedCount] for what
   *   copying `backfillSearch`'s `unindexedMeetings(1).size` would do to that loop.
   */
  @ReactMethod
  fun backfillItems(limit: Double, promise: Promise) {
    try {
      // The same requirement [ensureItems] has, and the failure it would produce here is quieter.
      // The migration re-runs the rule pass, which lives in libaudionotes.so; nothing loads that at
      // app start, and this runs on a plain library focus — where the odds of somebody having
      // recorded first are lower than on the path that opens a meeting. Without this line the JNI
      // call throws UnsatisfiedLinkError from inside ensureItems, where the runCatching below
      // swallows it per meeting: the loop finishes, the promise RESOLVES with a backlog that has
      // not moved, and the store reads that as a pass which made no progress. No rejection, no
      // error, and a library that never migrates. Loading up front is what keeps that failure loud,
      // because it is the only point on this path outside the per-meeting catch. Task 8 shipped
      // exactly this bug on ensureItems; StorageSweepTest is a class of its own so it cannot ship
      // twice.
      NativeBridge.ensureLoaded(ctx)
      val db = AudioDb.get(ctx)
      // [AudioDb.ensureItems] rather than [AudioDb.backfillItems] — the guarded one-meeting call,
      // not the unguarded one; both names mean "sweep the library" at every other layer. The guard
      // has already been applied by unmigratedMeetings, and is asked again because that batch is a
      // SNAPSHOT: the pipeline writes items into the same database while this drains, so a meeting
      // selected as unmigrated can have gained them by the time its turn comes. Re-asking costs two
      // queries per meeting and closes the window to one call.
      //
      // runCatching per meeting, the idiom [AudioDb.reindexImported] already uses for the same
      // reason, and batching is what makes it necessary here: one meeting that throws would reject
      // the whole promise and leave every meeting behind it in the batch untouched, on every pass —
      // one bad transcript freezing an entire library's migration. Swallowed, that meeting is left
      // unstamped and retried, and the backlog stops shrinking, which the loop already knows how to
      // stop on. The cost is diagnostic and lands on the next reader: a meeting whose rule pass
      // throws shows up as ItemSweepTest's drain test reporting a backlog that will not empty, a
      // message that points at the marker and the loop rather than at the meeting.
      for (id in db.unmigratedMeetings(limit.toInt())) runCatching { db.ensureItems(id) }
      promise.resolve(db.unmigratedCount().toDouble())
    } catch (e: Throwable) {
      promise.reject("db_backfill_items", e)
    }
  }

  @ReactMethod
  fun search(term: String, promise: Promise) {
    try {
      promise.resolve(AudioDb.get(ctx).searchJson(term))
    } catch (e: Exception) {
      promise.reject("db_search", e)
    }
  }

  private fun parseArgs(json: String): Array<String?> {
    val arr = JSONArray(json)
    return Array(arr.length()) { i -> if (arr.isNull(i)) null else arr.get(i).toString() }
  }
}
