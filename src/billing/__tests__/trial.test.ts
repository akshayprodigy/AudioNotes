/**
 * What the screens may say about Pro, and when the contextual offer is made.
 */
import {
  NUDGE_EVERY,
  NUDGE_MAX_REFUSALS,
  entitlement,
  isProModel,
  markPaywallSeen,
  noteNudgeShown,
  nudgeState,
  refuseNudge,
  shouldNudgeForPro,
  shouldOfferPaywall,
} from '../trial';

const { Storage, Licence } = (global as unknown as {
  __TEST_NATIVE_MODULES__: Record<string, Record<string, jest.Mock>>;
}).__TEST_NATIVE_MODULES__;

/** A settings table, as far as db.getSetting/db.setSetting can tell. */
const settings = new Map<string, string>();

const DAY = 24 * 60 * 60;
let systemNow = 1_800_000_000; // a fixed "today", in seconds

beforeEach(() => {
  settings.clear();
  jest.restoreAllMocks();
  jest.spyOn(Date, 'now').mockImplementation(() => systemNow * 1000);

  Licence.status.mockResolvedValue({
    plan: 'free',
    state: 'none',
    paid: false,
    expiresAt: 0,
    account: null,
    lapsedCopy: '',
  });

  Storage.query.mockImplementation(async (sql: string, argsJson: string) => {
    const args = JSON.parse(argsJson) as string[];
    if (sql.startsWith('SELECT value FROM settings')) {
      const v = settings.get(args[0]);
      return JSON.stringify(v === undefined ? [] : [{ value: v }]);
    }
    if (sql.startsWith('INSERT OR REPLACE INTO settings')) {
      settings.set(args[0], String(args[1]));
      return '[]';
    }
    return '[]';
  });
});

/** What the native licence store does on every entitlement read: ratchet the floor forward. */
const withNativeClock = () => {
  Licence.status.mockImplementation(async () => {
    const floor = Number(settings.get('licence_clock_floor') ?? 0);
    if (systemNow > floor) settings.set('licence_clock_floor', String(systemNow));
    return { plan: 'free', state: 'none', paid: false, expiresAt: 0, account: null, lapsedCopy: '' };
  });
};

describe('the contextual offer', () => {
  it('is made once and then never again', async () => {
    expect(await shouldOfferPaywall()).toBe(true);
    await markPaywallSeen();
    expect(await shouldOfferPaywall()).toBe(false);
  });

  it('is not made to a subscriber', async () => {
    Licence.status.mockResolvedValue({
      plan: 'pro',
      state: 'active',
      paid: true,
      expiresAt: systemNow + 30 * DAY,
      account: 'a@b.c',
      lapsedCopy: '',
    });
    expect(await shouldOfferPaywall()).toBe(false);
  });
});

describe('what Pro covers', () => {
  it('includes the bigger transcriber as well as the writer', () => {
    expect(isProModel({ id: 'whisper-small', needsSubscription: false })).toBe(true);
    expect(isProModel({ id: 'llm-qwen', needsSubscription: true })).toBe(true);
  });

  it('leaves the guaranteed path free', () => {
    expect(isProModel({ id: 'whisper-base', needsSubscription: false })).toBe(false);
    expect(isProModel({ id: 'silero-vad', needsSubscription: false })).toBe(false);
  });
});

describe('shouldNudgeForPro', () => {
  const free = { paid: false };
  const paid = { paid: true };

  it('waits until enough meetings have been finished', () => {
    expect(shouldNudgeForPro({ completed: 4, lastShownAt: 0, refusals: 0, entitlement: free })).toBe(false);
    expect(shouldNudgeForPro({ completed: 5, lastShownAt: 0, refusals: 0, entitlement: free })).toBe(true);
  });

  it('waits another full interval after each showing', () => {
    expect(shouldNudgeForPro({ completed: 6, lastShownAt: 5, refusals: 1, entitlement: free })).toBe(false);
    expect(shouldNudgeForPro({ completed: 10, lastShownAt: 5, refusals: 1, entitlement: free })).toBe(true);
  });

  it('survives a jump that skips the exact multiple', () => {
    // Importing several files at once moves the count 4 -> 7. A "multiple of 5" rule would never
    // fire again; this one does.
    expect(shouldNudgeForPro({ completed: 7, lastShownAt: 0, refusals: 0, entitlement: free })).toBe(true);
  });

  it('does not re-fire when meetings are deleted and remade', () => {
    // Shown at 10, user deletes down to 6. Nothing new has happened, so nothing is offered.
    expect(shouldNudgeForPro({ completed: 6, lastShownAt: 10, refusals: 1, entitlement: free })).toBe(false);
  });

  it('never offers to someone who is entitled', () => {
    // `paid` is true for a subscriber AND for a running trial — see entitlement().
    expect(shouldNudgeForPro({ completed: 50, lastShownAt: 0, refusals: 0, entitlement: paid })).toBe(false);
  });

  it('stops for good after the third refusal', () => {
    expect(
      shouldNudgeForPro({ completed: 100, lastShownAt: 0, refusals: NUDGE_MAX_REFUSALS, entitlement: free }),
    ).toBe(false);
    expect(
      shouldNudgeForPro({ completed: 100, lastShownAt: 0, refusals: NUDGE_MAX_REFUSALS - 1, entitlement: free }),
    ).toBe(true);
  });

  it('the interval is the one the card copy promises', () => {
    expect(NUDGE_EVERY).toBe(5);
  });
});

describe('nudge persistence', () => {
  it('starts at zero on a fresh install', async () => {
    expect(await nudgeState()).toEqual({ refusals: 0, lastShownAt: 0 });
  });

  it('remembers the count it was last shown at', async () => {
    await noteNudgeShown(5);
    expect(await nudgeState()).toEqual({ refusals: 0, lastShownAt: 5 });
  });

  it('counts refusals up to the cap', async () => {
    await refuseNudge();
    await refuseNudge();
    expect((await nudgeState()).refusals).toBe(2);
  });

  it('refusing does not disturb the count it was shown at', async () => {
    await noteNudgeShown(10);
    await refuseNudge();
    expect(await nudgeState()).toEqual({ refusals: 1, lastShownAt: 10 });
  });
});
