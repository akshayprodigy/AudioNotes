package com.audionotes.billing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The contract between the licence server and this app, pinned from both sides.
 *
 * The token below was not written by hand and was not minted by a helper. It came out of the
 * running server's POST /api/account/signin, for an account with a live subscription, and is
 * pasted here verbatim along with the public key that build was configured with. So this test
 * exercises the whole path a real device takes — HTTP endpoint, entitlement decision, signing key
 * from the environment, token format — against the verifier that actually ships.
 *
 * LicenceTest cannot catch any of what this catches. It mints with Java and verifies with Java,
 * so it would keep passing while the server produced something subtly different:
 *
 *  - Signature encoding. Java's SHA256withECDSA is DER. Node emits DER for EC keys by default but
 *    can be told to emit IEEE-P1363, and the two are not interchangeable.
 *  - What is signed: the base64url payload TEXT, not the decoded bytes. Both sides must choose
 *    the same thing and neither can observe the other's choice.
 *  - Public key encoding — SubjectPublicKeyInfo DER, base64.
 *  - Field order and separators in the payload.
 *
 * If the server's format drifts, this fails at build time rather than on a customer's phone the
 * morning after a deploy. Regenerate with server/scripts/contract-fixture.mjs.
 */
class LicenceContractTest {

  private val serverPublicKey =
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAElnQWMsn/5v4M2OTzfMuIbNr9lqvuoHYyAbEMtYaEmGToRkic90xS" +
      "+oGxoymSNuBFAt3BzsGnSQAtTSV2G9HqvQ=="

  private val serverToken =
    "dj0xO3N1Yj1hY2N0XzQ4YzI4ZGE3MGIwNTJmYjRkMjtwbGFuPXBybztpYXQ9MTc4Nzk4MzAyMDtleHA9MTc4OTE5" +
      "MjYyMDtkZXY9cGhvbmUtYWJj.MEUCIHuWKEjO1uddsfKo4fR6XrA-" +
      "pMNiWOlyE5gP73HFRynnAiEAxd2xpRFcaRkujbsWmusQmor3YPjxgnbQs7BevfQ7GBs"

  private val device = "phone-abc"

  /** Inside the token's window: issued 1787983020, expires 1789192620. */
  private val duringWindow = 1787983080L

  @Test
  fun `a token issued by the running licence server verifies here`() {
    val e = Licence.verify(serverToken, serverPublicKey, duringWindow, device)
    assertEquals(Licence.State.ACTIVE, e.state)
    assertTrue(e.isPaid)
  }

  @Test
  fun `the claims survive the crossing intact`() {
    val e = Licence.verify(serverToken, serverPublicKey, duringWindow, device)
    assertEquals("pro", e.plan)
    assertEquals("acct_48c28da70b052fb4d2", e.account)
    assertEquals(1789192620L, e.expiresAt)
  }

  @Test
  fun `the server's expiry is honoured on this side`() {
    assertEquals(
      Licence.State.EXPIRED,
      Licence.verify(serverToken, serverPublicKey, 1789192621L, device).state,
    )
  }

  @Test
  fun `the server's device binding is enforced on this side`() {
    assertEquals(
      Licence.State.NONE,
      Licence.verify(serverToken, serverPublicKey, duringWindow, "a-different-device").state,
    )
  }
}
