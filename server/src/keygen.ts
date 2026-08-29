/**
 * Generate the licence signing key pair. Run once, ever.
 *
 *   npm run keygen
 *
 * The private half signs every token and belongs only in the licence server's environment. The
 * public half is compiled into the Android app, so changing it later means every installed copy
 * stops accepting tokens until it updates — treat this key as permanent.
 */
import { generateSigningKeyPair, publicKeyForApp } from './licence.js';

const { privateKey, publicKey } = generateSigningKeyPair();
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

console.log('--- PRIVATE KEY — licence server environment only, never commit ---\n');
console.log('LICENCE_PRIVATE_KEY_PEM=' + JSON.stringify(pem));
console.log('\n--- PUBLIC KEY — android/gradle.properties ---\n');
console.log('licencePublicKey=' + publicKeyForApp(publicKey));
console.log('\nStore the private key in your host\'s secret manager now. It is not written to disk.');
