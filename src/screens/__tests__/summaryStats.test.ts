import { capturedParts, shortReset, summaryStats } from '../summaryStats';
import type { AllowanceStatus } from '../../native/NativeLicence';

const free = (over: Partial<AllowanceStatus> = {}): AllowanceStatus => ({
  limit: 5, used: 2, remaining: 3, period: '2026-10', resetsOn: '2026-11-01', paid: false, ...over,
});

describe('capturedParts', () => {
  it('stays in minutes under an hour', () => {
    expect(capturedParts(15)).toEqual([{ value: '15', unit: 'min' }]);
    expect(capturedParts(59)).toEqual([{ value: '59', unit: 'min' }]);
    expect(capturedParts(0)).toEqual([{ value: '0', unit: 'min' }]);
  });
  it('turns an hour or more into hours and minutes, dropping a zero remainder', () => {
    expect(capturedParts(60)).toEqual([{ value: '1', unit: 'h' }]);
    expect(capturedParts(65)).toEqual([{ value: '1', unit: 'h' }, { value: '5', unit: 'min' }]);
    expect(capturedParts(185)).toEqual([{ value: '3', unit: 'h' }, { value: '5', unit: 'min' }]);
  });
});

describe('shortReset', () => {
  it('abbreviates the month and falls back when the date is unreadable', () => {
    expect(shortReset('2026-11-01')).toBe('1 Nov');
    expect(shortReset('2027-01-01')).toBe('1 Jan');
    expect(shortReset('2026-13-01')).toBe('2026-13-01');
    expect(shortReset('soon')).toBe('soon');
  });
});

describe('summaryStats', () => {
  it('is saved and captured alone for Pro and before native has answered', () => {
    expect(summaryStats(19, 15, null).map(x => x.key)).toEqual(['saved', 'captured']);
    expect(summaryStats(19, 15, free({ paid: true })).map(x => x.key)).toEqual(['saved', 'captured']);
  });
  it('adds the allowance on a Free phone, with when it resets', () => {
    const [, , f] = summaryStats(19, 15, free());
    expect(f.parts).toEqual([{ value: '3', unit: 'of 5' }]);
    expect(f.caption).toBe('Resets 1 Nov');
    expect(f.spent).toBe(false);
    expect(f.spoken).toBe('3 of 5 free meetings left, resets 1 November');
  });
  it('marks a spent allowance, calmly: a flag for the ink, not an alert', () => {
    const [, , f] = summaryStats(19, 15, free({ used: 5, remaining: 0 }));
    expect(f.spent).toBe(true);
    expect(f.parts[0].value).toBe('0');
  });
  it('speaks one meeting in the singular and hours as words', () => {
    const [a, b] = summaryStats(1, 65, null);
    expect(a.spoken).toBe('1 meeting saved');
    expect(b.spoken).toBe('1 hour 5 min captured');
  });
});
