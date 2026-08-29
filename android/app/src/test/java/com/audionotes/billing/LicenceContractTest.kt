package com.audionotes.billing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The contract between the licence server and this app, pinned from both sides.
 *
 * LicenceTest proves the verifier is self-consistent — it mints with Java and verifies with Java,
 * which would keep passing even if the server produced something subtly different. This one uses
 * a token minted by the actual Node implementation in `server/src/licence.ts`, pasted here
 * verbatim. It is the only test that can catch the failures that matter across the boundary:
 *
 *  - Signature encoding. Java's SHA256withECDSA is DER; Node emits DER for EC keys by default but
 *    can be told to emit IEEE-P1363, and the two are not interchangeable. Nothing in either
 *    codebase states this in a way a compiler could check.
 *  - What exactly is signed. The signature covers the base64url payload TEXT, not the decoded
 *    bytes. Both sides have to make the same choice and neither can observe the other's.
 *  - Public key encoding. SubjectPublicKeyInfo DER, base64 — what X509EncodedKeySpec expects and
 *    what Node's `export({type:'spki'})` emits.
 *  - Field order and separators in the payload.
 *
 * If the server's format changes, this fails here rather than on a customer's phone the morning
 * after a deploy. Regenerate the fixture with server/scripts/contract-fixture.mjs.
 */
class LicenceContractTest {

  // Minted by server/src/licence.ts. The private half was thrown away — a fixture needs only the
  // public key and the signature it produced.
  private val serverPublicKey =
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEA+hZfyXgcFklTP5XwlUJHVKsZe4/0luQTG5yUflrmOLjafGVXbbZ" +
      "/vsziBchsKuMHjk4VLeba3GN6itdSCcTQQ=="

  private val serverToken =
    "dj0xO3N1Yj1hY2N0X2NvbnRyYWN0O3BsYW49cHJvO2lhdD0xNzU2NDAwMDAwO2V4cD0xNzU3NjA5NjAwO2Rldj1k" +
      "ZXZpY2UtY29udHJhY3Q.MEUCIAKLDXdjMJoSSh3PmmiyLWlduvtjt_wJq7GALE3kCSe8AiEA28BSD_RRT1pocXwD" +
      "YMEAZwBNHYACVPZnYjL05h5U1ew"

  private val device = "device-contract"

  /** Inside the token's window: issued 1756400000, expires 1757609600. */
  private val duringWindow = 1_756_500_000L

  @Test
  fun `a token minted by the licence server verifies here`() {
    val e = Licence.verify(serverToken, serverPublicKey, duringWindow, device)
    assertEquals(Licence.State.ACTIVE, e.state)
    assertTrue(e.isPaid)
  }

  @Test
  fun `the claims survive the crossing intact`() {
    val e = Licence.verify(serverToken, serverPublicKey, duringWindow, device)
    assertEquals("pro", e.plan)
    assertEquals("acct_contract", e.account)
    assertEquals(1_757_609_600L, e.expiresAt)
  }

  @Test
  fun `the server's expiry is honoured on this side`() {
    val afterWindow = 1_757_609_601L
    assertEquals(
      Licence.State.EXPIRED,
      Licence.verify(serverToken, serverPublicKey, afterWindow, device).state,
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
