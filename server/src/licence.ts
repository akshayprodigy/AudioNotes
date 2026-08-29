import {
  createPrivateKey,
  createPublicKey,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';

/**
 * Minting the tokens the Android app verifies offline.
 *
 * The other half of this contract is `billing/Licence.kt`. Both descriptions of the format have
 * to agree exactly, and neither can be changed alone — so licence.contract.test.ts mints a token
 * here with a fixed key and LicenceContractTest.kt asserts that the Kotlin verifier accepts that
 * exact string. If either side drifts, one of those two tests fails.
 *
 * ## Format
 *
 *     <base64url(payload)>.<base64url(signature)>
 *
 * payload — ASCII `k=v` pairs joined by `;`, in this order:
 *
 *     v=1;sub=<account>;plan=<plan>;iat=<unix s>;exp=<unix s>;dev=<device id>
 *
 * signature — SHA256withECDSA over the base64url payload TEXT (not the decoded bytes), DER
 * encoded, which is what Java's `Signature.getInstance("SHA256withECDSA")` produces and expects.
 * Node emits DER for EC keys by default; that default is load-bearing and is why the contract
 * test exists rather than a comment claiming it works.
 *
 * Values may contain neither `;` nor `=`, so they are rejected rather than escaped: every field
 * is an id or a number we generate, so a value needing an escape means something upstream is
 * wrong and should say so loudly.
 */

export const TOKEN_VERSION = 1;

/** How long a freshly minted token stays valid — and therefore how long an offline app keeps working. */
export const DEFAULT_TTL_SECONDS = 14 * 24 * 60 * 60;

export interface TokenClaims {
  account: string;
  plan: string;
  deviceId: string;
  /** Seconds. Defaults to DEFAULT_TTL_SECONDS. */
  ttlSeconds?: number;
  /** Overridable so tests can mint at a fixed instant. */
  issuedAt?: number;
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const FORBIDDEN = /[;=]/;

function field(name: string, value: string): string {
  if (!value) throw new Error(`licence: ${name} is empty`);
  if (FORBIDDEN.test(value)) {
    throw new Error(`licence: ${name} may not contain ';' or '=' (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Sign a licence token. `privateKey` is the P-256 key whose public half ships in the app. */
export function mintToken(privateKey: KeyObject, claims: TokenClaims): string {
  const issuedAt = claims.issuedAt ?? Math.floor(Date.now() / 1000);
  const ttl = claims.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  const payload = [
    `v=${TOKEN_VERSION}`,
    `sub=${field('account', claims.account)}`,
    `plan=${field('plan', claims.plan)}`,
    `iat=${issuedAt}`,
    `exp=${issuedAt + ttl}`,
    `dev=${field('deviceId', claims.deviceId)}`,
  ].join(';');

  const body = base64Url(Buffer.from(payload, 'ascii'));
  const signature = createSign('SHA256').update(body, 'ascii').sign(privateKey);
  return `${body}.${base64Url(signature)}`;
}

/**
 * The value that goes into the app's `licencePublicKey` Gradle property.
 *
 * SubjectPublicKeyInfo DER, base64 — exactly what Java's X509EncodedKeySpec reads.
 */
export function publicKeyForApp(publicKey: KeyObject): string {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

/** Generate a signing key pair. Run once, ever; see keygen.ts. */
export function generateSigningKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

/**
 * Load the signing key from the environment.
 *
 * PEM in an env var rather than a file on disk: the key must never be a build artifact or a git
 * object, and every host worth using injects secrets this way. Throws loudly on a missing key —
 * a licence server that starts without one would mint nothing and fail per-request instead,
 * which is a worse place to find out.
 */
export function signingKeyFromEnv(env: NodeJS.ProcessEnv = process.env): KeyObject {
  const pem = env.LICENCE_PRIVATE_KEY_PEM;
  if (!pem) {
    throw new Error(
      'LICENCE_PRIVATE_KEY_PEM is not set. Generate one with `npm run keygen` and put the ' +
        'private half in the environment — never in the repository.',
    );
  }
  return createPrivateKey(pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem);
}

export function publicKeyFrom(privateKey: KeyObject): KeyObject {
  return createPublicKey(privateKey);
}
