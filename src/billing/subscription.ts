import Billing from '../native/NativeBilling';
import Licence, { type LicenceStatus } from '../native/NativeLicence';
import { hostOf, record } from '../privacy/ledger';

/**
 * Talking to the licence server.
 *
 * The HTTP lives here in JS; the token itself is stored and verified natively, because a licence
 * a JS bundle could forge would not be a licence. Nothing in this file decides whether a paid
 * feature runs — it only fetches a signed token and hands it to the native side, which is the
 * only thing that judges it.
 */

/** Refresh once a token is inside this much of its expiry. */
const RENEW_WINDOW_SECONDS = 5 * 24 * 60 * 60;

async function post<T>(base: string, path: string, body: unknown): Promise<T> {
  const url = `${base.replace(/\/+$/, '')}${path}`;
  const payload = JSON.stringify(body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
  const text = await res.text();
  // Recorded whatever the server said, including a refusal: the bytes left the phone either way,
  // and a ledger that only counts successes is not a count of what left.
  await record({
    kind: 'licence',
    host: hostOf(url),
    sent: payload.length,
    received: text.length,
    detail: path,
  });
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // A proxy error page or a captive portal, not our server. Say something a person can act on
    // rather than surfacing a JSON parse error.
    throw new Error(`The licence server sent something unexpected (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    const message = (parsed as { error?: string })?.error;
    throw new Error(message ?? `The licence server refused the request (HTTP ${res.status}).`);
  }
  return parsed as T;
}

export interface SignInResult {
  email: string;
  plan: string;
  paid: boolean;
}

/**
 * Sign in and store whatever comes back.
 *
 * A successful sign-in with no subscription is NOT an error: the account exists, the person is on
 * the free tier, and telling them something went wrong would be a lie. `paid` carries the
 * difference.
 */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const base = await Licence.baseUrl();
  if (!base) throw new Error('This build has no licence server configured.');
  const deviceId = await Licence.deviceId();

  const res = await post<{
    email: string;
    refreshKey: string;
    token: string | null;
    plan: string;
    expiresAt: number;
  }>(base, '/api/account/signin', { email, password, deviceId });

  // The refresh key is stored even when there is no token yet, so a subscription bought later
  // can be picked up by a plain refresh instead of asking for the password again.
  await Licence.store(res.token ?? '', res.refreshKey);
  return { email: res.email, plan: res.plan, paid: Boolean(res.token) };
}

export async function signOut(): Promise<void> {
  await Licence.clear();
}

/**
 * Renew the token if it is close to expiring. Safe to call on every app open.
 *
 * Opportunistic on purpose: it never blocks anything, and a failure is silent. Losing the network
 * for a fortnight is what the token's remaining life is FOR, so a refresh that cannot happen is
 * not a condition worth interrupting anyone about — it only matters if it keeps failing until the
 * token runs out, and at that point the Summary tab says so.
 */
export async function refreshIfNeeded(now = Date.now() / 1000): Promise<LicenceStatus | null> {
  try {
    const base = await Licence.baseUrl();
    if (!base) return null;

    const status = await Licence.status();
    // An unlicensed development build reports active with no expiry; there is nothing to renew.
    if (status.state === 'active' && status.expiresAt === 0) return null;

    const key = await Licence.refreshKey();
    if (!key) return null;

    const soon = status.expiresAt > 0 && status.expiresAt - now < RENEW_WINDOW_SECONDS;
    // Also refresh when the token has already lapsed: the subscription may have been renewed on
    // the web since, and that is exactly the moment to find out.
    if (!soon && status.state !== 'expired' && status.state !== 'none') return null;

    const deviceId = await Licence.deviceId();
    const res = await post<{ token: string | null; plan: string; expiresAt: number }>(
      base,
      '/api/licence/refresh',
      { deviceId, refreshKey: key },
    );
    if (!res.token) return null;
    await Licence.store(res.token, null);
    return await Licence.status();
  } catch {
    return null;
  }
}


// --- Google Play Billing -----------------------------------------------------------------------
//
// The Play route to the same place. `Billing` obtains a purchase token; the server is the only
// thing that can turn one into a licence, because a token is a claim and the signature on a licence
// is a proof.

export interface PlayResult {
  /** False when the buyer backed out, or when payment is still authorising. Not an error. */
  paid: boolean;
  /** Set when the purchase succeeded but the server could not be told about it yet. */
  pendingServer?: boolean;
}

/**
 * Send a purchase token to the licence server and store whatever comes back.
 *
 * On failure it asks Play to acknowledge the purchase locally. That is a fallback, not the plan:
 * the server acknowledges after recording entitlement, which is the ordering that cannot strand a
 * payer. But if the server is unreachable and the app is never opened again, Google refunds an
 * unacknowledged purchase after three days — and somebody who wanted the subscription loses it
 * silently. Acknowledging here costs nothing and closes that hole.
 */
async function redeem(base: string, purchaseToken: string): Promise<PlayResult> {
  const deviceId = await Licence.deviceId();
  try {
    const res = await post<{ token: string | null; refreshKey: string; plan: string }>(
      base,
      '/api/billing/play/link',
      { purchaseToken, deviceId },
    );
    await Licence.store(res.token ?? '', res.refreshKey);
    return { paid: Boolean(res.token) };
  } catch (e) {
    await Billing.acknowledgeLocally(purchaseToken).catch(() => false);
    throw e;
  }
}

/** Whether this install can buy through Play at all. False on a side-load or another store. */
export async function playAvailable(): Promise<boolean> {
  try {
    return await Billing.available();
  } catch {
    return false;
  }
}

export async function playPrice(): Promise<string | null> {
  try {
    return (await Billing.price())?.price ?? null;
  } catch {
    return null;
  }
}

/** Buy through Play, then exchange the purchase for a licence. */
export async function buyWithPlay(): Promise<PlayResult> {
  const base = await Licence.baseUrl();
  if (!base) throw new Error('This build has no licence server configured.');

  const purchaseToken = await Billing.purchase();
  // Null covers two different things that need the same handling: the buyer changed their mind,
  // and a payment method still authorising. Neither is a failure worth an error dialog.
  if (!purchaseToken) return { paid: false };
  return redeem(base, purchaseToken);
}

/**
 * Pick up a subscription this Google account already owns.
 *
 * "Restore purchases", and also what makes a new phone or a reinstall work: Play remembers what was
 * bought, and the server turns that back into a licence for this device. Safe to call on every
 * launch — it is a no-op when nothing is owned.
 */
export async function restorePlayPurchase(): Promise<PlayResult> {
  const base = await Licence.baseUrl();
  if (!base) return { paid: false };

  const purchaseToken = await Billing.restore().catch(() => null);
  if (!purchaseToken) return { paid: false };
  return redeem(base, purchaseToken);
}
