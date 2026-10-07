import {
  exhaustedCopy,
  explainer,
  formatReset,
  freeHeadline,
  importErrorCopy,
  meaningSearchOffer,
  remainingCopy,
  statusLine,
  settingsValue,
} from '../allowanceCopy';
import type { AllowanceStatus } from '../../native/NativeLicence';

const free = (over: Partial<AllowanceStatus> = {}): AllowanceStatus => ({
  limit: 5, used: 2, remaining: 3, period: '2026-10', resetsOn: '2026-11-01', paid: false, ...over,
});

describe('formatReset', () => {
  it('writes the day without a leading zero and the month in words', () => {
    expect(formatReset('2026-11-01')).toBe('1 November');
    expect(formatReset('2027-01-01')).toBe('1 January');
    expect(formatReset('2026-12-01')).toBe('1 December');
  });

  it('names every month', () => {
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    names.forEach((n, i) => expect(formatReset(`2026-${String(i + 1).padStart(2, '0')}-01`)).toBe(`1 ${n}`));
  });

  it('hands back what it cannot read rather than inventing a date', () => {
    expect(formatReset('')).toBe('');
    expect(formatReset('soon')).toBe('soon');
    expect(formatReset('2026-13-01')).toBe('2026-13-01');
  });
});

describe('the spec strings (plan section 3)', () => {
  it('pins the headline', () => {
    expect(freeHeadline).toBe('Free: 5 meetings each month · up to 1 hour each.');
  });

  it('pins the remaining line', () => {
    expect(remainingCopy(3, 5, '2026-11-01')).toBe('3 of 5 free meetings left · resets 1 November.');
    expect(remainingCopy(1, 5, '2027-01-01')).toBe('1 of 5 free meetings left · resets 1 January.');
    expect(remainingCopy(0, 5, '2026-11-01')).toBe('0 of 5 free meetings left · resets 1 November.');
  });

  it('pins the exhausted line', () => {
    expect(exhaustedCopy('2026-11-01')).toBe(
      "You've used your 5 free meetings this month. Your saved meetings are still available. " +
        'Get Pro for more meetings, or record again from 1 November.',
    );
  });

  it('pins the explainer', () => {
    expect(explainer).toBe('Imports and dictations count as meetings.');
  });
});

describe('statusLine', () => {
  it('is the remaining line for a Free phone', () => {
    expect(statusLine(free())).toBe('3 of 5 free meetings left · resets 1 November.');
  });

  it('is nothing at all for Pro', () => {
    expect(statusLine(free({ paid: true }))).toBeNull();
  });

  it('is nothing when native could not say', () => {
    expect(statusLine(null)).toBeNull();
  });
});

describe('settingsValue', () => {
  it('says unlimited for Pro', () => {
    expect(settingsValue(free({ paid: true }))).toBe('Unlimited with Pro');
  });

  it('says remaining and reset for Free', () => {
    expect(settingsValue(free())).toBe('3 of 5 left · resets 1 November');
  });

  it('is empty until native has answered', () => {
    expect(settingsValue(null)).toBe('');
  });
});

describe('importErrorCopy', () => {
  it('is the exhausted line for allowance_exhausted, with the upgrade offer', () => {
    expect(importErrorCopy('allowance_exhausted', '2026-11-01')).toEqual({ text: exhaustedCopy('2026-11-01'), upgrade: true });
  });

  it('names the hour and offers Pro for a file that is too long', () => {
    expect(importErrorCopy('import_too_long', 'whatever')).toEqual({
      text: 'That recording is longer than the 1 hour Free limit. Pro has no length limit.',
      upgrade: true,
    });
  });

  it('tells the user to finish recording first, with no upgrade offer', () => {
    expect(importErrorCopy('recording_in_progress', 'x')).toEqual({ text: 'Finish recording first', upgrade: false });
  });

  it('tells the user to finish the import first', () => {
    expect(importErrorCopy('import_in_progress', 'x')).toEqual({ text: 'Finish the import first', upgrade: false });
  });

  it('leaves every other failure to the caller', () => {
    expect(importErrorCopy('import_failed', 'x')).toBeNull();
    expect(importErrorCopy(undefined, 'x')).toBeNull();
  });
});

describe('meaningSearchOffer', () => {
  it('offers Pro for search by meaning, and does not promise what Free lacks is keyword search', () => {
    expect(meaningSearchOffer).toBe('Pro also searches by meaning, so a question finds the answer even when the words differ.');
    expect(meaningSearchOffer).not.toMatch(/Search every word/);
  });
});
