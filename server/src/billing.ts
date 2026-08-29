import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import Razorpay from 'razorpay';
import type { Store } from './store.js';

/**
 * Razorpay subscriptions.
 *
 * Bought on the web rather than through Play Billing, because the app ships to more than the Play
 * Store, because a desktop build cannot use Play Billing at all, and because one entitlement
 * service is simpler than one-and-a-half. The trade is that we own the subscription lifecycle:
 * renewals, failed payments, cancellations. That is what the webhook below is.
 *
 * The app never opens any of this. It signs in; the buying happens on the web, in a browser,
 * where store policy has nothing to say about it.
 */

export const PLAN_ID = process.env.RAZORPAY_PLAN_ID ?? '';

function client(): Razorpay | null {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) return null;
  return new Razorpay({ key_id, key_secret });
}

/** HMAC-SHA256 of the RAW body, compared in constant time. */
export function webhookSignatureMatches(body: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Map a Razorpay subscription status onto ours.
 *
 * Razorpay has more states than the entitlement question needs. `halted` means retries have been
 * exhausted, which is a harder stop than `pending`; both are past_due to us, and the difference
 * that matters — how long the grace lasts — is decided by the period end, not the label.
 */
function mapStatus(status: string): 'active' | 'past_due' | 'cancelled' | 'none' {
  switch (status) {
    case 'active':
    case 'authenticated':
      return 'active';
    case 'pending':
    case 'halted':
      return 'past_due';
    case 'cancelled':
    case 'completed':
    case 'expired':
      return 'cancelled';
    default:
      return 'none';
  }
}

export function billingRoutes(app: Express, store: Store): void {
  /**
   * Start a subscription. Returns Razorpay's hosted checkout URL to redirect to.
   *
   * The hosted page rather than an embedded checkout: it handles UPI AutoPay, cards, netbanking
   * and their respective failure paths, all of which we would otherwise be reimplementing and
   * getting subtly wrong on somebody's bank.
   */
  app.post('/api/billing/subscribe', async (req: Request, res: Response) => {
    const rzp = client();
    if (!rzp || !PLAN_ID) {
      return res.status(503).json({
        error: 'Billing is not configured on this server (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_PLAN_ID).',
      });
    }
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'Sign in to subscribe' });
    }
    const account = store.authenticate(email, password);
    if (!account) return res.status(401).json({ error: 'Email or password is incorrect' });

    try {
      const subscription = await rzp.subscriptions.create({
        plan_id: PLAN_ID,
        // 120 monthly cycles — Razorpay requires a finite count, and ten years is long enough
        // that nobody reaches it before we have changed something else.
        total_count: 120,
        customer_notify: 1,
        notes: { accountId: account.id, email: account.email },
      });

      // Recorded as pending BEFORE the user pays, so the webhook that follows can find the
      // account from the subscription id. A payment whose account we cannot identify is a
      // support ticket and a refund.
      store.upsertSubscription({
        accountId: account.id,
        plan: 'pro',
        providerId: subscription.id,
        status: 'none',
        currentPeriodEnd: 0,
      });

      res.json({ subscriptionId: subscription.id, checkoutUrl: (subscription as { short_url?: string }).short_url });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not start the subscription';
      res.status(502).json({ error: message });
    }
  });

  /**
   * Razorpay's webhook. The only thing that may mark a subscription paid.
   *
   * Never trust a redirect back from a checkout page to mean payment succeeded — a browser can be
   * pointed anywhere by anyone. The webhook is signed, and it is what moves money into
   * entitlement.
   */
  app.post('/api/billing/webhook', (req: Request, res: Response) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.status(503).send('webhook not configured');

    const signature = req.header('x-razorpay-signature') ?? '';
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !webhookSignatureMatches(raw, signature, secret)) {
      return res.status(400).send('bad signature');
    }

    let event: {
      event?: string;
      payload?: { subscription?: { entity?: Record<string, unknown> } };
    };
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).send('bad json');
    }

    // Razorpay retries on any non-2xx, so the same charge can arrive twice. Claiming the event id
    // first means a retry is acknowledged without extending the period a second time.
    const eventId = req.header('x-razorpay-event-id') ?? '';
    if (eventId && !store.claimEvent(eventId)) return res.status(200).send('duplicate');

    const entity = event.payload?.subscription?.entity;
    if (!entity) return res.status(200).send('ignored');

    const providerId = String(entity.id ?? '');
    const accountId = providerId ? store.accountByProviderId(providerId) : null;
    if (!accountId) {
      // 200, not an error: retrying will not make an unknown subscription known, and a webhook
      // Razorpay keeps retrying forever is noise that hides real failures.
      return res.status(200).send('unknown subscription');
    }

    const status = mapStatus(String(entity.status ?? ''));
    const periodEnd = Number(entity.current_end ?? entity.end_at ?? 0) || 0;
    const existing = store.subscription(accountId);

    store.upsertSubscription({
      accountId,
      plan: 'pro',
      providerId,
      status,
      // Never move the paid-through date backwards. Events can arrive out of order, and the
      // version that does move it back takes away time somebody has already paid for.
      currentPeriodEnd: Math.max(existing.currentPeriodEnd, periodEnd),
    });

    res.status(200).send('ok');
  });
}
