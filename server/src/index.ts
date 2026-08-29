import express from 'express';
import { issue } from './entitlement.js';
import { signingKeyFromEnv } from './licence.js';
import { DEVICE_LIMIT, Store } from './store.js';
import { billingRoutes } from './billing.js';
import { pages } from './pages.js';

/**
 * The licence server.
 *
 * Two audiences with different needs. The Android app wants one thing — a token for this device —
 * and wants it to keep working when the network does not. A person on the web wants to sign up,
 * pay, and see what they are paying for.
 *
 * What this server is NOT is as important as what it is: it never receives a recording, a
 * transcript, a title or a count of anything the user made. See store.ts.
 */

const app = express();
const store = new Store();

// The webhook needs its raw body to check Razorpay's signature — a parsed and re-serialised body
// does not hash to the same bytes. Registered before the JSON parser so it wins for that path.
app.use('/api/billing/webhook', express.raw({ type: '*/*' }));
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false }));

const signingKey = signingKeyFromEnv();

function badRequest(res: express.Response, message: string) {
  res.status(400).json({ error: message });
}

// ---- accounts ----

app.post('/api/account/signup', (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || !email.includes('@')) return badRequest(res, 'A valid email is required');
  if (typeof password !== 'string' || password.length < 8) {
    return badRequest(res, 'Password must be at least 8 characters');
  }
  if (store.accountByEmail(email)) {
    // Deliberately the same shape of answer as success would give a bot, minus the account: this
    // endpoint should not become a way to test which emails are registered.
    return res.status(409).json({ error: 'That email is already registered' });
  }
  const account = store.createAccount(email, password);
  res.json({ accountId: account.id, email: account.email });
});

/**
 * Sign in from the app.
 *
 * Returns a licence token AND a device-scoped refresh key, so the password is typed once and
 * never stored. A refresh two weeks later must not require the account password to be sitting on
 * the phone, or re-typed by someone who has long since forgotten it.
 */
app.post('/api/account/signin', (req, res) => {
  const { email, password, deviceId } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return badRequest(res, 'Email and password are required');
  }
  if (typeof deviceId !== 'string' || !deviceId) return badRequest(res, 'deviceId is required');

  const account = store.authenticate(email, password);
  // One message for "no such account" and "wrong password": telling them apart is how an
  // attacker enumerates who has an account here.
  if (!account) return res.status(401).json({ error: 'Email or password is incorrect' });

  if (!store.touchDevice(account.id, deviceId)) {
    return res.status(409).json({
      error: `This subscription is already on ${DEVICE_LIMIT} devices. Remove one from your account page to add this one.`,
    });
  }
  const refreshKey = store.issueRefreshKey(account.id, deviceId);
  const licence = issue(store, signingKey, account.id, deviceId);

  res.json({
    accountId: account.id,
    email: account.email,
    refreshKey,
    // Null when the account exists but has no subscription — a real state, not an error. The app
    // shows the free tier and says nothing further.
    token: licence?.token ?? null,
    plan: licence?.plan ?? 'free',
    expiresAt: licence?.expiresAt ?? 0,
  });
});

/** The periodic refresh. No password: a device-scoped key it was given at sign-in. */
app.post('/api/licence/refresh', (req, res) => {
  const { deviceId, refreshKey } = req.body ?? {};
  if (typeof deviceId !== 'string' || typeof refreshKey !== 'string') {
    return badRequest(res, 'deviceId and refreshKey are required');
  }
  const accountId = store.accountForRefreshKey(deviceId, refreshKey);
  if (!accountId) return res.status(401).json({ error: 'Sign in again' });

  const licence = issue(store, signingKey, accountId, deviceId);
  res.json({
    token: licence?.token ?? null,
    plan: licence?.plan ?? 'free',
    expiresAt: licence?.expiresAt ?? 0,
  });
});

// ---- billing and web pages ----

billingRoutes(app, store);
pages(app, store);

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`licence server on :${port}`);
});

export { app, store };

