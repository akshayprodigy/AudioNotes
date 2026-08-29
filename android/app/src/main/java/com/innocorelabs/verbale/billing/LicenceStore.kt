package com.innocorelabs.verbale.billing

import android.content.Context
import android.util.Log
import com.innocorelabs.verbale.BuildConfig
import com.innocorelabs.verbale.data.AudioDb
import java.util.UUID

/**
 * Where the licence lives on the device, and the only thing the rest of the app talks to.
 *
 * [Licence] is the pure half — parsing, signatures, the clock rule — and is unit tested. This is
 * the glue: three rows in the `settings` table, read from code that often runs with no React
 * context at all (the processing service after a process restart), which is why it goes through
 * AudioDb rather than anything on the JS side.
 */
object LicenceStore {
  private const val TAG = "Licence"

  /** What a build with no licence key hands out: everything, and honestly labelled. */
  private val UNLICENSED_BUILD = Licence.Entitlement(
    plan = "unlicensed-build",
    state = Licence.State.ACTIVE,
    expiresAt = Long.MAX_VALUE,
    account = null,
  )

  private const val KEY_TOKEN = "licence_token"
  private const val KEY_FLOOR = "licence_clock_floor"
  private const val KEY_DEVICE = "licence_device_id"
  private const val KEY_REFRESH = "licence_refresh_key"

  /**
   * This device's identity, for binding a token to it.
   *
   * A random value we generate and keep, NOT a hardware identifier. ANDROID_ID and friends are
   * restricted on modern Android, they follow a user across unrelated apps, and they would tie a
   * subscription to a handset rather than to an install — so a factory reset would look like
   * piracy. A UUID costs us nothing and identifies no one.
   */
  fun deviceId(ctx: Context): String {
    val db = AudioDb.get(ctx)
    db.getSetting(KEY_DEVICE)?.takeIf { it.isNotBlank() }?.let { return it }
    val fresh = UUID.randomUUID().toString()
    db.putSetting(KEY_DEVICE, fresh)
    return fresh
  }

  /**
   * What this install is currently entitled to.
   *
   * Cheap and offline — a signature check over a couple of hundred bytes — so callers can ask on
   * demand rather than caching it and going stale the moment a subscription lapses.
   */
  fun current(ctx: Context): Licence.Entitlement {
    // No key configured means licensing is not wired up yet, not that nobody has paid.
    //
    // The alternative — treating an unconfigured build as "everyone is on the free tier" — is
    // worse in both directions it can fail. Every development build would silently lose the
    // feature under active development, and a release accidentally built without the key would
    // lock out every paying customer at once, which reads to them as a total outage. Unlocked is
    // the safer failure: it costs revenue, not trust.
    //
    // Shipping a release in this state is prevented at the other end, in build.gradle, which
    // refuses to assemble a release build with no key rather than leaving it to be noticed.
    if (BuildConfig.LICENCE_PUBLIC_KEY.isBlank()) return UNLICENSED_BUILD

    return try {
      val db = AudioDb.get(ctx)
      val now = advanceClock(db)
      Licence.verify(
        token = db.getSetting(KEY_TOKEN),
        publicKeyB64 = BuildConfig.LICENCE_PUBLIC_KEY,
        now = now,
        deviceId = deviceId(ctx),
      )
    } catch (e: Exception) {
      // A licence that cannot be read is not a licence, but it must never be a crash: this runs
      // on the path that transcribes a meeting the user has already recorded.
      Log.w(TAG, "could not read entitlement", e)
      Licence.NONE
    }
  }

  /**
   * Store a freshly issued token, and the device-scoped key that will renew it.
   *
   * The refresh key is kept so the account password never has to be. A renewal a fortnight from
   * now should not need a password sitting on the phone, or retyped by someone who has long
   * since forgotten it.
   */
  fun store(ctx: Context, token: String, refreshKey: String? = null): Licence.Entitlement {
    val db = AudioDb.get(ctx)
    db.putSetting(KEY_TOKEN, token)
    if (!refreshKey.isNullOrBlank()) db.putSetting(KEY_REFRESH, refreshKey)
    return current(ctx)
  }

  fun refreshKey(ctx: Context): String? =
    AudioDb.get(ctx).getSetting(KEY_REFRESH)?.takeIf { it.isNotBlank() }

  /**
   * Forget the licence — signing out, or a token the server has disowned.
   *
   * The device id is deliberately kept. It identifies this install to the account, and rotating
   * it on every sign-out would burn through the device limit for anyone who signs out and back
   * in, which is the ordinary way to fix a problem.
   */
  fun clear(ctx: Context) {
    val db = AudioDb.get(ctx)
    db.putSetting(KEY_TOKEN, "")
    db.putSetting(KEY_REFRESH, "")
  }

  /**
   * The monotonic clock, persisted.
   *
   * Reads the highest time ever seen, takes the later of that and the system clock, and writes it
   * back. Winding the phone back therefore buys nothing; winding it forward is honoured at once
   * and simply moves the floor with it — a user correcting a genuinely wrong clock loses nothing.
   */
  private fun advanceClock(db: AudioDb): Long {
    val floor = db.getSetting(KEY_FLOOR)?.toLongOrNull() ?: 0L
    val now = Licence.monotonicNow(System.currentTimeMillis() / 1000L, floor)
    if (now > floor) db.putSetting(KEY_FLOOR, now.toString())
    return now
  }
}
