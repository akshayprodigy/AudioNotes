package com.audionotes.billing

import com.audionotes.data.AudioDb
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * The subscription, as the UI sees it.
 *
 * Read-mostly: the screens ask what the holder is entitled to so they can say something true
 * about it. Enforcement does not live here — it is in Narrator.run, on the native side, where it
 * cannot be stepped around by anything running in JS.
 */
class LicenceModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "Licence"

  /**
   * The copy shown when a subscription has lapsed.
   *
   * Server-supplied, with this as the fallback. Where an app may point someone towards paying,
   * and in what words, is a store-policy question that moves independently of our release
   * schedule — so the sentence is data, refreshed with the token, and not a string frozen into
   * an APK that takes a week to update.
   *
   * The default states a fact and sells nothing, which is the safe thing to say anywhere.
   */
  private val defaultLapsedCopy =
    "Your subscription has ended. Your recordings, transcripts and minutes are all still here."

  /**
   * One call, because every caller wants the same three things: may I use the paid features, why
   * not if not, and what should I say about it.
   */
  @ReactMethod
  fun status(promise: Promise) {
    try {
      val e = LicenceStore.current(ctx)
      val copy = AudioDb.get(ctx).getSetting("licence_lapsed_copy")?.takeIf { it.isNotBlank() }
      promise.resolve(
        Arguments.createMap().apply {
          putString("plan", e.plan)
          putString("state", e.state.name.lowercase())
          putBoolean("paid", e.isPaid)
          // Seconds, and 0 when there is nothing to expire. JS gets a number it can compare
          // rather than a formatted date it would have to parse back.
          putDouble("expiresAt", if (e.expiresAt == Long.MAX_VALUE) 0.0 else e.expiresAt.toDouble())
          putString("account", e.account)
          putString("lapsedCopy", copy ?: defaultLapsedCopy)
        },
      )
    } catch (e: Exception) {
      promise.reject("licence_status_failed", e)
    }
  }

  /** Take a freshly issued token — from sign-in, or from the periodic refresh. */
  @ReactMethod
  fun store(token: String, promise: Promise) {
    try {
      val e = LicenceStore.store(ctx, token)
      promise.resolve(e.isPaid)
    } catch (e: Exception) {
      promise.reject("licence_store_failed", e)
    }
  }

  /** Sign out, or drop a token the server has disowned. */
  @ReactMethod
  fun clear(promise: Promise) {
    try {
      LicenceStore.clear(ctx)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("licence_clear_failed", e)
    }
  }

  /**
   * This install's id, for the sign-in page to bind a token to.
   *
   * A UUID we generated, not a hardware identifier — see LicenceStore.deviceId.
   */
  @ReactMethod
  fun deviceId(promise: Promise) {
    try {
      promise.resolve(LicenceStore.deviceId(ctx))
    } catch (e: Exception) {
      promise.reject("licence_device_failed", e)
    }
  }
}
