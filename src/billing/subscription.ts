import Licence, { type LicenceStatus } from '../native/NativeLicence';

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
  const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
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
