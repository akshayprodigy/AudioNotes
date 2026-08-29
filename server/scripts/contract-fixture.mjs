/**
 * Regenerate the fixture pinned by LicenceContractTest.kt.
 *
 *   node --experimental-strip-types scripts/contract-fixture.mjs
 *
 * Paste the output into android/app/src/test/java/com/audionotes/billing/LicenceContractTest.kt.
 * Only needed when the token format itself changes — which is the moment both sides must be
 * checked against each other again, which is the point of the fixture.
 */
import { mintToken, generateSigningKeyPair, publicKeyForApp } from '../src/licence.ts';

const { privateKey, publicKey } = generateSigningKeyPair();
const issuedAt = 1756400000;
const ttlSeconds = 1209600;

console.log('publicKey:', publicKeyForApp(publicKey));
console.log('token:    ', mintToken(privateKey, {
  account: 'acct_contract',
  plan: 'pro',
  deviceId: 'device-contract',
  issuedAt,
  ttlSeconds,
}));
console.log('window:   ', issuedAt, '→', issuedAt + ttlSeconds);
