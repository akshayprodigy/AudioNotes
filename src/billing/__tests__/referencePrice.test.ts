/**
 * What the paywall may honestly show struck through.
 *
 * This is the only place in the app that produces a "was" price, and a wrong answer here is not a
 * rendering bug — it is a false claim about money. A reference price the seller never charged is a
 * fabricated anchor: forbidden by the EU Omnibus Directive, covered by India's dark-pattern rules,
 * and grounds for Play rejection. So the rule is narrow on purpose. There are exactly two honest
 * sources, and everything else returns null.
 */
import { referencePrice } from '../subscription';
import type { PlayPlan } from '../../native/NativeBilling';

const plan = (over: Partial<PlayPlan>): PlayPlan => ({
  basePlanId: 'x',
  price: null,
  priceMicros: 0,
  period: null,
  fullPrice: null,
  trialPeriod: null,
  trialCycles: 0,
  title: 'Verbale Pro',
  ...over,
});

// The founder's launch prices.
const monthlyINR = plan({ basePlanId: 'monthly', price: '₹299', priceMicros: 299e6, period: 'P1M' });
const annualINR = plan({ basePlanId: 'annual', price: '₹2,499', priceMicros: 2499e6, period: 'P1Y' });
const monthlyUSD = plan({ basePlanId: 'monthly', price: '$4.99', priceMicros: 4.99e6, period: 'P1M' });
const annualUSD = plan({ basePlanId: 'annual', price: '$39.99', priceMicros: 39.99e6, period: 'P1Y' });

describe('referencePrice', () => {
  it('strikes an annual plan against twelve months, which is true by arithmetic', () => {
    const r = referencePrice(annualINR, [monthlyINR, annualINR]);
    // 299 x 12 = 3,588. Not a number anyone invented: it is what a year of monthly costs.
    expect(r).toEqual({ was: '₹3,588', savedPercent: 30 });
  });

  it('keeps the sample currency\'s decimals and never rounds the "was" price up', () => {
    // $4.99 x 12 is $59.88. Showing "$60" would overstate what the buyer is compared against —
    // the same fabricated anchor this whole function exists to avoid, only smaller.
    const r = referencePrice(annualUSD, [monthlyUSD, annualUSD]);
    expect(r?.was).toBe('$59.88');
    expect(r?.savedPercent).toBe(33);
  });

  it('shows nothing for a monthly plan, because there is nothing to compare it to', () => {
    expect(referencePrice(monthlyINR, [monthlyINR, annualINR])).toBeNull();
  });

  it('shows nothing for an annual plan when no monthly price is available', () => {
    expect(referencePrice(annualINR, [annualINR])).toBeNull();
  });

  it('refuses when the annual plan costs more than paying monthly', () => {
    const dear = plan({ basePlanId: 'annual', price: '₹4,000', priceMicros: 4000e6, period: 'P1Y' });
    expect(referencePrice(dear, [monthlyINR, dear])).toBeNull();
  });

  it("uses Play's own full price when an introductory offer is running", () => {
    // The legitimate route to "was ₹350, now ₹299": configure ₹350 in Play Console and ₹299 as an
    // introductory offer. Play then reports both, and the strikethrough describes a real price.
    const intro = plan({
      basePlanId: 'monthly', price: '₹299', priceMicros: 299e6, period: 'P1M', fullPrice: '₹350',
    });
    expect(referencePrice(intro, [intro])?.was).toBe('₹350');
  });

  it('formats a comma-decimal locale the way Play returned it', () => {
    const m = plan({ basePlanId: 'monthly', price: '4,99 \u20ac', priceMicros: 4.99e6, period: 'P1M' });
    const a = plan({ basePlanId: 'annual', price: '39,99 \u20ac', priceMicros: 39.99e6, period: 'P1Y' });
    expect(referencePrice(a, [m, a])?.was).toBe('59,88 \u20ac');
  });

  it('never invents a number when Play reports a single phase and no annual comparison', () => {
    expect(referencePrice(plan({ price: '₹299', priceMicros: 299e6, period: 'P1M' }), [])).toBeNull();
  });
});
