package com.innocorelabs.verbale.billing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The contract between the licence server and this app, pinned from both sides.
 *
 * The token below was not written by hand and was not minted by a helper. It came out of the
 * running licence server's POST /api/account/signin -- over a real socket, for an account with a
 * live subscription -- and is pasted here verbatim along with the public key that server was
 * configured with. So this test exercises the whole path a real device takes: HTTP endpoint,
 * entitlement decision, signing key from the environment, token format, against the verifier that
 * actually ships.
 *
 * The server is Python. This is Kotlin. Nothing but this test observes that both agree.
 *
 * LicenceTest cannot catch any of what this catches. It mints with Java and verifies with Java, so
 * it would keep passing while the server produced something subtly different:
 *
 *  - Signature encoding. Java's SHA256withECDSA is DER. Python's `cryptography` emits DER for EC
 *    keys, but IEEE-P1363 (raw r||s) is the same length and the same bytes-looking thing, and Java
 *    rejects it.
 *  - What is signed: the base64url payload TEXT, not the decoded bytes. Both sides must choose the
 *    same thing and neither can observe the other's choice.
 *  - Public key encoding -- SubjectPublicKeyInfo DER, base64.
 *  - Field order and separators in the payload.
 *
 * If the server's format drifts, this fails at build time rather than on a customer's phone the
 * morning after a deploy. Regenerate with `python scripts/contract_fixture.py` in server/.
 */
class LicenceContractTest {

  private val serverPublicKey =
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAExb0A0ht2J2l0Wv1J3PZlNN6Dis0echsxj14CeF/1erlvXV9ge3fCDxnP" +
      "1V1Cmxn8+FqPvt5Q02WyQNyWMPrimg=="

  private val serverToken =
    "dj0xO3N1Yj1hY2N0XzVjODk5NzNmMzJiZjk2ODcyNDtwbGFuPXBybztpYXQ9MTc4Nzk4NjAwNTtleHA9MTc4OTE5NTYw" +
      "NTtkZXY9ZGV2aWNlLWNvbnRyYWN0.MEUCIAlOSM4nrPdZrPvQEe6Wq9n8BlCqExtgM1dbEqC-LJXoAiEA60t4UTKz61v" +
      "lQexzOEaKw5pMMBZYRgGmVAiAJStdhOk"

  private val device = "device-contract"

  /** Inside the token's window: issued 1787986005, expires 1789195605. */
  private val duringWindow = 1787986065L

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
    assertEquals("acct_5c89973f32bf968724", e.account)
    assertEquals(1789195605L, e.expiresAt)
  }

  @Test
  fun `the server's expiry is honoured on this side`() {
    assertEquals(
      Licence.State.EXPIRED,
      Licence.verify(serverToken, serverPublicKey, 1789195606L, device).state,
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
