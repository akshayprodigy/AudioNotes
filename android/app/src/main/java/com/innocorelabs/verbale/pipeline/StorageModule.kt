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
   * The caller is `MeetingScreen.refresh` in JavaScript, which awaits this before it reads the
   * meeting and memoises it per opening. There is exactly ONE, and see [AudioDb.ensureItems] for
   * why a second would be worse than none.
   */
  @ReactMethod
  fun ensureItems(meetingId: String, promise: Promise) {
    try {
      // The ONLY method on this module that reaches native code. The migration re-runs the rule
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
