package com.audionotes.billing

import java.io.ByteArrayOutputStream
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/**
 * Offline verification of a subscription licence.
 *
 * The app deliberately does NOT ask a server "is this person paid?". It holds a short-lived token
 * the server signed, and checks the signature itself. That choice buys three things:
 *
 *  - A paying customer on a plane, on a bad connection, or in a hospital basement keeps the app
 *    they paid for. The token's remaining life IS the grace period.
 *  - Our licence server having a bad afternoon does not brick every subscriber at once.
 *  - There is no call home on launch, so "nothing you record is ever uploaded" stays literally
 *    true and the only thing that ever leaves the phone is a token refresh carrying no meeting
 *    data.
 *
 * ## Token format
 *
 *     <base64url(payload)>.<base64url(signature)>
 *
 * where payload is ASCII `k=v` pairs separated by `;`, and the signature is SHA256withECDSA
 * (P-256) over the base64url payload text exactly as it appears in the token:
 *
 *     v=1;sub=acct_7f3;plan=pro;iat=1756400000;exp=1757609600;dev=d41d8cd98f
 *
 * Not JSON, and not a JWT. Three reasons: it needs no parser dependency, it behaves identically
 * on the JVM (where these tests run) and on Android, and the desktop build will have to verify
 * the same token from C++, where six fixed fields split on two characters is a morning's work and
 * a JSON parser is a dependency argument. Values may not contain `;` or `=`.
 *
 * ## What it deliberately does not do
 *
 * This is a lock on a door in the customer's own house. Anyone determined can patch the check out
 * of the APK, and no amount of cleverness here changes that. The real barrier is that the
 * language model weights are a licensed download — bypassing this flag leaves you with an app
 * that still has no model to run. Treat this as the thing that tells an honest user where they
 * stand, not as a thing that stops a dishonest one.
 */
object Licence {

  /**
   * NONE and EXPIRED are kept apart on purpose. "Your subscription ran out" is a sentence worth
   * showing someone, with a way to fix it; "there is no licence here" is the ordinary state of
   * every free user and deserves no interruption at all. Collapsing them would nag people who
   * never subscribed.
   */
  enum class State { NONE, ACTIVE, EXPIRED }

  data class Entitlement(
    val plan: String,
    val state: State,
    val expiresAt: Long,
    val account: String?,
  ) {
    /** The gate every paid feature asks. */
    val isPaid: Boolean get() = state == State.ACTIVE
  }

  val NONE = Entitlement(plan = "free", state = State.NONE, expiresAt = 0L, account = null)

  /**
   * The clock a licence is judged against.
   *
   * Winding the phone clock back is the obvious way to stretch an expired token, so time is only
   * ever allowed to move forward: the caller persists the highest value ever seen and passes it
   * back as `floor`. A user who legitimately corrects a wrong clock loses nothing, because a
   * correction forward is honoured immediately.
   */
  fun monotonicNow(systemNow: Long, floor: Long): Long = maxOf(systemNow, floor)

  /**
   * Verify a token and say what it entitles the holder to.
   *
   * Anything that fails — malformed, wrong signature, unknown version, issued for another device
   * — returns [NONE] rather than throwing. A forged licence and a missing one are the same thing
   * to the app: not paid. Only a genuine, correctly signed, correctly targeted token that has
   * simply run out of time comes back EXPIRED.
   */
  fun verify(token: String?, publicKeyB64: String, now: Long, deviceId: String): Entitlement {
    if (token.isNullOrBlank() || publicKeyB64.isBlank()) return NONE

    val dot = token.indexOf('.')
    if (dot <= 0 || dot == token.length - 1) return NONE
    val payloadB64 = token.substring(0, dot)
    val sigB64 = token.substring(dot + 1)

    val sig = base64Url(sigB64) ?: return NONE
    if (!signatureHolds(payloadB64, sig, publicKeyB64)) return NONE

    val payload = base64Url(payloadB64)?.toString(Charsets.US_ASCII) ?: return NONE
    val f = fields(payload) ?: return NONE

    if (f["v"] != "1") return NONE
    val exp = f["exp"]?.toLongOrNull() ?: return NONE
    val plan = f["plan"]?.takeIf { it.isNotBlank() } ?: return NONE

    // A token is bound to the device it was issued for, so lifting one out of a friend's phone
    // buys nothing. An unbound token (no `dev`) is rejected rather than trusted broadly.
    val dev = f["dev"] ?: return NONE
    if (dev != deviceId) return NONE

    return Entitlement(
      plan = plan,
      state = if (exp > now) State.ACTIVE else State.EXPIRED,
      expiresAt = exp,
      account = f["sub"],
    )
  }

  private fun signatureHolds(payloadB64: String, sig: ByteArray, publicKeyB64: String): Boolean =
    try {
      val der = base64Url(publicKeyB64.replace('+', '-').replace('/', '_'))
      if (der == null) {
        false
      } else {
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(der))
        Signature.getInstance("SHA256withECDSA").run {
          initVerify(key)
          update(payloadB64.toByteArray(Charsets.US_ASCII))
          verify(sig)
        }
      }
    } catch (_: Exception) {
      // A bad key, a bad signature encoding and an unavailable algorithm all mean the same thing
      // here, and none of them should crash an app on launch.
      false
    }

  /** `k=v;k=v` into a map. Null if any pair is malformed, so a mangled token cannot half-parse. */
  private fun fields(payload: String): Map<String, String>? {
    val out = HashMap<String, String>()
    for (pair in payload.split(';')) {
      if (pair.isEmpty()) continue
      val eq = pair.indexOf('=')
      if (eq <= 0 || eq == pair.length - 1) return null
      out[pair.substring(0, eq)] = pair.substring(eq + 1)
    }
    return out.ifEmpty { null }
  }

  /**
   * base64url decode. Hand-rolled because java.util.Base64 is API 26 and this app supports 24,
   * and android.util.Base64 does not exist on the JVM these tests run on.
   */
  private fun base64Url(s: String): ByteArray? {
    val out = ByteArrayOutputStream(s.length * 3 / 4 + 3)
    var acc = 0
    var bits = 0
    for (c in s) {
      if (c == '=') break
      val v = if (c.code < 128) REV[c.code] else -1
      if (v < 0) return null
      acc = (acc shl 6) or v
      bits += 6
      if (bits >= 8) {
        bits -= 8
        out.write((acc shr bits) and 0xFF)
      }
    }
    return out.toByteArray()
  }

  private val REV = IntArray(128) { -1 }.also { table ->
    val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    for (i in alphabet.indices) table[alphabet[i].code] = i
    // Tokens are minted base64url, but a public key pasted into gradle.properties is very often
    // standard base64. Accepting both costs two entries and saves a baffling build-time failure.
    table['+'.code] = 62
    table['/'.code] = 63
  }
}
