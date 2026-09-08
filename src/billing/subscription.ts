import Billing, { type PlayPlan } from '../native/NativeBilling';
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

/** Monthly and annual, as Play describes them. Empty when Play cannot be reached. */
export async function playPlans(): Promise<PlayPlan[]> {
  try {
    return await Billing.plans();
  } catch {
    return [];
  }
}

/**
 * What a plan may honestly show struck through, and what it saves.
 *
 * Two sources, both real. Play's own `fullPrice` when an introductory offer means the buyer is
 * charged less than the standing rate; otherwise, for an annual plan, twelve times the monthly
 * price — a comparison that is true by arithmetic rather than by assertion.
 *
 * Returns null when neither applies. It never invents a number: a "was" price nobody was ever
 * charged is a fabricated anchor, and this app does not make claims it cannot support.
 */
export function referencePrice(
  plan: PlayPlan,
  plans: PlayPlan[],
): { was: string; savedPercent: number } | null {
  if (plan.fullPrice && plan.priceMicros > 0) {
    const monthly = plans.find((p) => p.period === 'P1M');
    const full = plan.fullPrice;
    // The saving is only computable when Play gave us both numbers; show the strike either way.
    const fullMicros = monthly && plan.basePlanId === monthly.basePlanId ? monthly.priceMicros : 0;
    const pct = fullMicros > plan.priceMicros
      ? Math.round((1 - plan.priceMicros / fullMicros) * 100)
      : 0;
    return { was: full, savedPercent: pct };
  }
  if (plan.period !== 'P1Y') return null;
  const monthly = plans.find((p) => p.period === 'P1M');
  if (!monthly || monthly.priceMicros <= 0 || plan.priceMicros <= 0) return null;
  const yearAtMonthlyRate = monthly.priceMicros * 12;
  if (yearAtMonthlyRate <= plan.priceMicros) return null;
  // Shaped from the monthly price Play returned, so the symbol and separators match its locale.
  // No renderable "was" means no strikethrough: a claim we cannot state exactly is not made.
  const was = formatLike(monthly.price, yearAtMonthlyRate);
  if (was === null) return null;
  return {
    was,
    savedPercent: Math.round((1 - plan.priceMicros / yearAtMonthlyRate) * 100),
  };
}

/**
 * Render `micros` using the currency symbol, grouping and decimal places of an already-localised
 * Play price. Returns null when the sample cannot be read confidently.
 *
 * Deliberately narrow: it copies the shape of a string Google produced rather than choosing a
 * format itself. Intl is unavailable in this Hermes build (see the language-name fix), and a
 * hand-rolled currency formatter is wrong in exactly the markets that matter.
 *
 * It must never round UP. $4.99 x 12 is $59.88, and showing "$60" would overstate the price the
 * buyer is being compared against — the same fabricated anchor this function exists to avoid,
 * only smaller. So the decimal places of the sample are mirrored exactly, and a sample this
 * cannot parse produces no strikethrough at all.
 */
function formatLike(sample: string | null, micros: number): string | null {
  if (!sample) return null;
  const core = sample.match(/[\d][\d.,\u00A0 ]*[\d]|[\d]/)?.[0];
  if (!core) return null;
  const prefix = sample.slice(0, sample.indexOf(core));
  const suffix = sample.slice(sample.indexOf(core) + core.length);

  // The last separator followed by exactly two digits is a decimal point; anything else groups.
  const tail = core.match(/([.,])(\d{2})$/);
  const decimalSep = tail ? tail[1] : '';
  const decimals = tail ? 2 : 0;
  const groupSep = decimalSep === ',' ? '.' : ',';

  const units = micros / 1_000_000;
  const whole = Math.floor(units);
  const frac = Math.round((units - whole) * 100);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
  const body = decimals === 2 ? `${grouped}${decimalSep}${String(frac).padStart(2, '0')}` : grouped;
  return `${prefix}${body}${suffix}`;
}

/** Buy through Play, then exchange the purchase for a licence. */
export async function buyWithPlay(basePlanId: string | null = null): Promise<PlayResult> {
  const base = await Licence.baseUrl();
  if (!base) throw new Error('This build has no licence server configured.');

  const purchaseToken = await Billing.purchase(basePlanId);
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
