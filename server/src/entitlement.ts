import type { KeyObject } from 'node:crypto';
import { DEFAULT_TTL_SECONDS, mintToken } from './licence.js';
import type { Store, Subscription } from './store.js';

/**
 * Deciding what to mint, and for how long.
 *
 * The app verifies a token offline and keeps working until it expires, so the expiry is not a
 * detail — it is the exact length of time a cancelled subscriber keeps the paid features, and the
 * exact length of time a legitimate subscriber survives without a network. Both directions are
 * paid for here.
 */

/**
 * How long past the paid-through date a token may still be minted.
 *
 * Card renewals fail for boring reasons — an expired card, a bank's fraud heuristic, a daily
 * limit — and Razorpay retries over the following days. Cutting someone off at the exact second
 * their period ends would punish them for their bank's behaviour, in an app they are mid-meeting
 * with. Three days covers the retries without turning a cancellation into a free fortnight.
 */
export const PAYMENT_GRACE_SECONDS = 3 * 24 * 60 * 60;

export interface Issued {
  token: string;
  plan: string;
  expiresAt: number;
}

/** Whether a subscription is currently worth minting against. */
export function isEntitled(sub: Subscription, now: number): boolean {
  if (sub.status === 'active') return true;
  // past_due is still entitled, but only inside the grace window — that is what past_due means.
  if (sub.status === 'past_due') return now < sub.currentPeriodEnd + PAYMENT_GRACE_SECONDS;
  // A cancelled subscription runs to the end of the period already paid for. Taking it away at
  // the moment of cancelling would be charging for time and then not giving it.
  if (sub.status === 'cancelled') return now < sub.currentPeriodEnd;
  return false;
}

/**
 * Mint a licence for one device, or return null if the account is not entitled.
 *
 * The token never outlives the paid period plus its grace, so a subscription that lapses cannot
 * be extended by asking for a fresh token the day before it ends.
 */
export function issue(
  store: Store,
  signingKey: KeyObject,
  accountId: string,
  deviceId: string,
  now = Math.floor(Date.now() / 1000),
): Issued | null {
  const sub = store.subscription(accountId);
  if (!isEntitled(sub, now)) return null;
  if (!store.touchDevice(accountId, deviceId)) return null;

  const ceiling = sub.currentPeriodEnd + PAYMENT_GRACE_SECONDS;
  const ttl = Math.min(DEFAULT_TTL_SECONDS, Math.max(0, ceiling - now));
  if (ttl <= 0) return null;

  return {
    token: mintToken(signingKey, {
      account: accountId,
      plan: sub.plan,
      deviceId,
      issuedAt: now,
      ttlSeconds: ttl,
    }),
    plan: sub.plan,
    expiresAt: now + ttl,
  };
}
