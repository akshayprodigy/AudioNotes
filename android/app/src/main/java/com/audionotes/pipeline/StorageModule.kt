package com.audionotes.pipeline

import com.audionotes.data.AudioDb
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
