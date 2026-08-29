package com.innocorelabs.verbale.billing

import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The licence check decides whether someone who has paid keeps working and whether someone who
 * has not is told so. Both failures are expensive: one refunds, the other leaks the product.
 *
 * These run on the JVM against real P-256 keys, so the crypto path under test is the one that
 * ships — no mocking, and no device, which matters because connectedAndroidTest uninstalls the
 * app and takes the downloaded models and the meeting database with it.
 */
class LicenceTest {

  private val keys: KeyPair = KeyPairGenerator.getInstance("EC").run {
    initialize(ECGenParameterSpec("secp256r1"))
    generateKeyPair()
  }
  private val publicKey = b64u(keys.public.encoded)
  private val device = "d41d8cd98f"
  private val now = 1_756_400_000L

  private fun b64u(bytes: ByteArray): String {
    val a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    val sb = StringBuilder()
    var i = 0
    while (i < bytes.size) {
      val b0 = bytes[i].toInt() and 0xFF
      val b1 = if (i + 1 < bytes.size) bytes[i + 1].toInt() and 0xFF else 0
      val b2 = if (i + 2 < bytes.size) bytes[i + 2].toInt() and 0xFF else 0
      sb.append(a[b0 shr 2])
      sb.append(a[((b0 and 0x03) shl 4) or (b1 shr 4)])
      if (i + 1 < bytes.size) sb.append(a[((b1 and 0x0F) shl 2) or (b2 shr 6)])
      if (i + 2 < bytes.size) sb.append(a[b2 and 0x3F])
      i += 3
    }
    return sb.toString()
  }

  /** Mint a token the way the licence server will. */
  private fun mint(
    payload: String,
    signWith: PrivateKey = keys.private,
  ): String {
    val body = b64u(payload.toByteArray(Charsets.US_ASCII))
    val sig = Signature.getInstance("SHA256withECDSA").run {
      initSign(signWith)
      update(body.toByteArray(Charsets.US_ASCII))
      sign()
    }
    return "$body.${b64u(sig)}"
  }

  private fun payload(exp: Long, dev: String = device, plan: String = "pro", v: String = "1") =
    "v=$v;sub=acct_7f3;plan=$plan;iat=$now;exp=$exp;dev=$dev"

  @Test
  fun `a current token entitles the holder`() {
    val e = Licence.verify(mint(payload(now + 1209600)), publicKey, now, device)
    assertEquals(Licence.State.ACTIVE, e.state)
    assertEquals("pro", e.plan)
    assertEquals("acct_7f3", e.account)
    assertTrue(e.isPaid)
  }

  // The remaining life of the token IS the grace period: a subscriber offline for a week still
  // holds a token minted a week ago, and keeps working.
  @Test
  fun `a token still inside its window survives with no network`() {
    val issuedTwoWeeks = mint(payload(now + 1209600))
    val sixDaysLater = now + 6 * 86400
    assertEquals(Licence.State.ACTIVE, Licence.verify(issuedTwoWeeks, publicKey, sixDaysLater, device).state)
  }

  @Test
  fun `a lapsed token reads as expired, not as absent`() {
    val e = Licence.verify(mint(payload(now - 1)), publicKey, now, device)
    // The distinction is the whole point: EXPIRED earns a "renew" message, NONE earns silence.
    assertEquals(Licence.State.EXPIRED, e.state)
    assertFalse(e.isPaid)
    assertNotEquals(Licence.State.NONE, e.state)
  }

  @Test
  fun `a token signed by someone else is not a licence`() {
    val impostor = KeyPairGenerator.getInstance("EC").run {
      initialize(ECGenParameterSpec("secp256r1"))
      generateKeyPair()
    }
    val forged = mint(payload(now + 1209600), signWith = impostor.private)
    assertEquals(Licence.State.NONE, Licence.verify(forged, publicKey, now, device).state)
  }

  @Test
  fun `editing the payload breaks the signature`() {
    val token = mint(payload(now - 1))
    val body = token.substringBefore('.')
    val tampered = b64u(payload(now + 999999).toByteArray(Charsets.US_ASCII)) +
      "." + token.substringAfter('.')
    assertNotEquals(body, tampered.substringBefore('.'))
    assertEquals(Licence.State.NONE, Licence.verify(tampered, publicKey, now, device).state)
  }

  // Lifting a token off a friend's phone should buy nothing.
  @Test
  fun `a token minted for another device is refused`() {
    val theirs = mint(payload(now + 1209600, dev = "someone-elses-phone"))
    assertEquals(Licence.State.NONE, Licence.verify(theirs, publicKey, now, device).state)
  }

  @Test
  fun `a token with no device binding is refused rather than trusted broadly`() {
    val unbound = mint("v=1;sub=acct_7f3;plan=pro;iat=$now;exp=${now + 1000}")
    assertEquals(Licence.State.NONE, Licence.verify(unbound, publicKey, now, device).state)
  }

  @Test
  fun `an unknown token version is refused`() {
    val future = mint(payload(now + 1209600, v = "2"))
    assertEquals(Licence.State.NONE, Licence.verify(future, publicKey, now, device).state)
  }

  @Test
  fun `garbage in any position is not a licence`() {
    for (bad in listOf(null, "", "   ", "no-dot-here", ".", "a.", ".b", "!!!.???", "a.b.c")) {
      assertEquals(
        "expected NONE for ${bad ?: "null"}",
        Licence.State.NONE,
        Licence.verify(bad, publicKey, now, device).state,
      )
    }
  }

  @Test
  fun `a missing public key cannot accidentally pass anything`() {
    val good = mint(payload(now + 1209600))
    assertEquals(Licence.State.NONE, Licence.verify(good, "", now, device).state)
  }

  @Test
  fun `free users are simply not paid`() {
    assertEquals(Licence.State.NONE, Licence.NONE.state)
    assertFalse(Licence.NONE.isPaid)
    assertEquals("free", Licence.NONE.plan)
  }

  // Winding the phone clock back is the obvious way to stretch an expired token.
  @Test
  fun `time is not allowed to run backwards`() {
    val floor = now
    assertEquals(now, Licence.monotonicNow(systemNow = now - 90 * 86400, floor = floor))
  }

  @Test
  fun `a clock corrected forwards is honoured at once`() {
    assertEquals(now + 500, Licence.monotonicNow(systemNow = now + 500, floor = now))
  }

  @Test
  fun `winding the clock back does not resurrect a lapsed token`() {
    val lapsed = mint(payload(now - 1))
    val pretendItIsLastYear = now - 365 * 86400
    val guarded = Licence.monotonicNow(systemNow = pretendItIsLastYear, floor = now)
    assertEquals(Licence.State.EXPIRED, Licence.verify(lapsed, publicKey, guarded, device).state)
  }
}
