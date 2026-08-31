/**
 * The trial's rules, which are the only thing in this lane that can silently give away the product
 * or silently take it back.
 *
 * The clock is the interesting half. Everything here that matters is about a phone whose owner is
 * allowed to set its clock to anything they like.
 */
import {
  TRIAL_DAYS,
  TRIAL_SUMMARIES,
  entitlement,
  isProModel,
  markPaywallSeen,
  noteTrialSummary,
  shouldOfferPaywall,
  startTrial,
  trialState,
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

describe('starting', () => {
  it('is unstarted until somebody starts it', async () => {
    const state = await trialState();
    expect(state.status).toBe('unstarted');
    expect(state.daysLeft).toBe(TRIAL_DAYS);
    expect(state.summariesLeft).toBe(TRIAL_SUMMARIES);
  });

  it('grants the entitlement while it runs', async () => {
    await startTrial();
    const e = await entitlement();
    expect(e.paid).toBe(true);
    expect(e.viaTrial).toBe(true);
  });

  it('does not restart on a second tap', async () => {
    const first = await startTrial();
    systemNow += 3 * DAY;
    const second = await startTrial();
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.daysLeft).toBe(TRIAL_DAYS - 3);
  });
});

describe('the two limits', () => {
  it('ends when the window runs out', async () => {
    await startTrial();
    systemNow += TRIAL_DAYS * DAY + 1;
    const state = await trialState();
    expect(state.status).toBe('ended');
    expect(state.endedBecause).toBe('time');
    expect((await entitlement()).paid).toBe(false);
  });

  it('ends on the last summary of the cap', async () => {
    await startTrial();
    for (let i = 0; i < TRIAL_SUMMARIES; i++) await noteTrialSummary();
    const state = await trialState();
    expect(state.status).toBe('ended');
    expect(state.endedBecause).toBe('summaries');
    expect(state.summariesLeft).toBe(0);
  });

  it('does not spend a summary that a subscriber wrote', async () => {
    await startTrial();
    Licence.status.mockResolvedValue({
      plan: 'pro',
      state: 'active',
      paid: true,
      expiresAt: systemNow + 30 * DAY,
      account: 'a@b.c',
      lapsedCopy: '',
    });
    await noteTrialSummary();
    expect((await trialState()).used).toBe(0);
  });

  it('stops counting once it is over', async () => {
    await startTrial();
    systemNow += TRIAL_DAYS * DAY + 1;
    await noteTrialSummary();
    expect((await trialState()).used).toBe(0);
  });
});

describe('the clock', () => {
  it('does not extend when the phone is wound back', async () => {
    withNativeClock();
    await startTrial();

    // Six days pass honestly, then the owner sets the phone back a fortnight.
    systemNow += 6 * DAY;
    await trialState();
    systemNow -= 14 * DAY;

    const state = await trialState();
    // One day left, not fifteen: the floor the licence store keeps is what is read, not Date.now().
    expect(state.status).toBe('active');
    expect(state.daysLeft).toBe(1);

    systemNow += 15 * DAY;
    expect((await trialState()).status).toBe('ended');
  });

  it('stays ended after a wind-back, because ending is written down', async () => {
    withNativeClock();
    await startTrial();
    systemNow += TRIAL_DAYS * DAY + 1;
    expect((await trialState()).status).toBe('ended');

    settings.delete('licence_clock_floor'); // the harshest case: the floor itself is gone
    systemNow -= 30 * DAY;
    expect((await trialState()).status).toBe('ended');
  });
});

describe('the contextual offer', () => {
  it('is made once and then never again', async () => {
    expect(await shouldOfferPaywall()).toBe(true);
    await markPaywallSeen();
    expect(await shouldOfferPaywall()).toBe(false);
  });

  it('is not made to somebody who already decided', async () => {
    await startTrial();
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
