import type { PlayPlan } from '../../native/NativeBilling';
import { trialLength, trialPlan, trialTerms } from '../trialTerms';

const plan = (o: Partial<PlayPlan>): PlayPlan => ({
  basePlanId: 'monthly',
  price: '₹299',
  priceMicros: 299e6,
  period: 'P1M',
  fullPrice: null,
  trialPeriod: null,
  trialCycles: 0,
  title: 'Verbale Pro',
  ...o,
});
const monthlyTrial = plan({ trialPeriod: 'P1W', trialCycles: 1 });
const annualTrial = plan({
  basePlanId: 'annual', price: '₹2,499', priceMicros: 2499e6, period: 'P1Y',
  trialPeriod: 'P7D', trialCycles: 1,
});
const annual = plan({ basePlanId: 'annual', price: '₹2,499', priceMicros: 2499e6, period: 'P1Y' });

describe('trialLength', () => {
  it('reads a week and seven days as the same seven days', () => {
    expect(trialLength(monthlyTrial)).toBe('7 days');
    expect(trialLength(plan({ trialPeriod: 'P7D', trialCycles: 1 }))).toBe('7 days');
  });
  it('multiplies by the cycle count', () => {
    expect(trialLength(plan({ trialPeriod: 'P1W', trialCycles: 2 }))).toBe('14 days');
    expect(trialLength(plan({ trialPeriod: 'P2W', trialCycles: 1 }))).toBe('14 days');
  });
  it('says one day and one month in the singular', () => {
    expect(trialLength(plan({ trialPeriod: 'P1D', trialCycles: 1 }))).toBe('1 day');
    expect(trialLength(plan({ trialPeriod: 'P1M', trialCycles: 1 }))).toBe('1 month');
  });
  it('is null with no trial or an unreadable period', () => {
    expect(trialLength(plan({}))).toBeNull();
    expect(trialLength(plan({ trialPeriod: 'garbage', trialCycles: 1 }))).toBeNull();
  });
});

describe('trialTerms', () => {
  it('states the length, the price after, how often, and how to avoid paying', () => {
    expect(trialTerms(monthlyTrial)).toBe(
      'Free for 7 days, then ₹299 a month until you cancel. Cancel in Google Play before the trial ends and you pay nothing.',
    );
    expect(trialTerms(annualTrial)).toBe(
      'Free for 7 days, then ₹2,499 a year until you cancel. Cancel in Google Play before the trial ends and you pay nothing.',
    );
  });
  it('never invents a period it cannot name', () => {
    expect(trialTerms({ ...monthlyTrial, period: 'P2M' })).toBe(
      'Free for 7 days, then ₹299 each billing period until you cancel. Cancel in Google Play before the trial ends and you pay nothing.',
    );
  });
  it('is null without a trial', () => {
    expect(trialTerms(annual)).toBeNull();
  });
});

describe('trialPlan', () => {
  it('prefers the asked-for period when both plans have a trial', () => {
    expect(trialPlan([monthlyTrial, annualTrial], 'P1Y')?.basePlanId).toBe('annual');
  });
  it('falls back to whichever plan has one', () => {
    expect(trialPlan([monthlyTrial, annual], 'P1Y')?.basePlanId).toBe('monthly');
  });
  it('is null when no plan has a trial', () => {
    expect(trialPlan([plan({}), annual], 'P1M')).toBeNull();
  });
});
