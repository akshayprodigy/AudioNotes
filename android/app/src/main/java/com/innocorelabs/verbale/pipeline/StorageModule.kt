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
   * Shaped like [reindex] and per-meeting for the same reason: this is a few milliseconds of pure
   * text over stored utterances, so it belongs on the path that opens a meeting rather than in a
   * library-wide sweep. [backfillSearch] is chunked and JS-driven because a full-library index
   * build would ANR the main thread on a Quick Settings cold start; none of that applies here, and
   * copying the chunked shape would only add a migration nobody can tell has finished.
   *
   * NOTHING CALLS THIS YET, and that is expected rather than an oversight: Task 9 is "the
   * JavaScript side reads items", and the call belongs beside that read. It is declared now so the
   * API is real and typed on both sides (see src/native/NativeStorage.ts) instead of arriving
   * half-built with the screen that needs it. An uncalled migration is the same shape as the trap
   * this sub-project already hit once — `item_done` had no writer, so a join that looked correct
   * saw nothing a real user had done — so it is written down rather than left to be discovered.
   */
  @ReactMethod
  fun ensureItems(meetingId: String, promise: Promise) {
    try {
      AudioDb.get(ctx).ensureItems(meetingId)
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
