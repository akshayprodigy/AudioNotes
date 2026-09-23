import type { PlayPlan } from '../native/NativeBilling';

/**
 * Play's free trial, in words.
 *
 * Pure and native-free on purpose, so every screen that mentions the trial can use it in tests
 * without mocking anything. The trial itself is Play's — an offer on each base plan, shown only
 * to an account that has never subscribed — and nothing here grants or checks it.
 *
 * Play's subscription policy asks for the length, the price after it, how often that price is
 * charged, and how to cancel, stated where the offer is made. `trialTerms` is that sentence.
 */

const UNIT: Record<string, [string, string, number]> = {
  D: ['day', 'days', 1],
  W: ['day', 'days', 7],
  M: ['month', 'months', 1],
  Y: ['year', 'years', 1],
};

/** "7 days" for a one-week trial; null when the plan has none or the period cannot be read. */
export function trialLength(plan: Pick<PlayPlan, 'trialPeriod' | 'trialCycles'>): string | null {
  const m = /^P(\d+)([DWMY])$/.exec(plan.trialPeriod ?? '');
  if (!m) return null;
  const [one, many, factor] = UNIT[m[2]];
  const n = Number(m[1]) * factor * Math.max(1, plan.trialCycles);
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

const EVERY: Record<string, string> = {
  P1W: 'a week',
  P1M: 'a month',
  P3M: 'every 3 months',
  P6M: 'every 6 months',
  P1Y: 'a year',
};

/** The terms sentence shown with every trial offer. Null when the plan has no trial. */
export function trialTerms(plan: PlayPlan): string | null {
  const length = trialLength(plan);
  if (!length || !plan.price) return null;
  const every = EVERY[plan.period ?? ''] ?? 'each billing period';
  return (
    `Free for ${length}, then ${plan.price} ${every} until you cancel. ` +
    'Cancel in Google Play before the trial ends and you pay nothing.'
  );
}

/** The plan to offer a trial on: `prefer`'s period if it has one, else any plan that does. */
export function trialPlan(plans: PlayPlan[], prefer: 'P1M' | 'P1Y'): PlayPlan | null {
  return (
    plans.find(p => trialLength(p) !== null && p.period === prefer) ??
    plans.find(p => trialLength(p) !== null) ??
    null
  );
}
