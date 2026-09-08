/**
 * The free tier's length limit.
 *
 * What matters here is not the arithmetic but the two promises around it: the warning arrives
 * early enough to act on, and the cap is a stop rather than a loss. The second is enforced in
 * RecordingService; these tests pin the first, and the boundaries where a policy is easiest to
 * get wrong by one.
 */
import {
  FREE_CAP_MS,
  NO_CAP,
  WARN_BEFORE_MS,
  capMsFor,
  capPhase,
  countdown,
  secondsLeft,
} from '../recordingCap';

const MIN = 60 * 1000;

describe('who is capped', () => {
  it('caps a free recording at fifteen minutes', () => {
    expect(capMsFor(false)).toBe(FREE_CAP_MS);
    expect(FREE_CAP_MS).toBe(15 * MIN);
  });

  it('does not cap a subscriber, or somebody inside a trial', () => {
    // entitlement().paid is true for both, which is what lets the offer at minute twelve keep a
    // recording running instead of restarting it.
    expect(capMsFor(true)).toBe(NO_CAP);
  });
});

describe('phases', () => {
  it('runs quietly until three minutes are left', () => {
    expect(capPhase(0, FREE_CAP_MS)).toBe('running');
    expect(capPhase(11 * MIN, FREE_CAP_MS)).toBe('running');
  });

  it('warns exactly three minutes out, not a moment later', () => {
    expect(capPhase(FREE_CAP_MS - WARN_BEFORE_MS, FREE_CAP_MS)).toBe('warning');
    expect(capPhase(FREE_CAP_MS - WARN_BEFORE_MS - 1, FREE_CAP_MS)).toBe('running');
  });

  it('reaches the cap at the cap, not after it', () => {
    expect(capPhase(FREE_CAP_MS - 1, FREE_CAP_MS)).toBe('warning');
    expect(capPhase(FREE_CAP_MS, FREE_CAP_MS)).toBe('reached');
    expect(capPhase(FREE_CAP_MS + 5 * MIN, FREE_CAP_MS)).toBe('reached');
  });

  it('never says anything about a recording with no cap', () => {
    expect(capPhase(0, NO_CAP)).toBe('uncapped');
    expect(capPhase(90 * MIN, NO_CAP)).toBe('uncapped');
  });
});

describe('the countdown', () => {
  it('reads as minutes and seconds', () => {
    expect(countdown(12 * MIN, FREE_CAP_MS)).toBe('3:00');
    expect(countdown(12 * MIN + 1000, FREE_CAP_MS)).toBe('2:59');
    expect(countdown(FREE_CAP_MS - 500, FREE_CAP_MS)).toBe('0:01');
  });

  it('stops at zero rather than going negative', () => {
    expect(countdown(FREE_CAP_MS + 10_000, FREE_CAP_MS)).toBe('0:00');
    expect(secondsLeft(FREE_CAP_MS + 10_000, FREE_CAP_MS)).toBe(0);
  });

  it('has nothing to count for an uncapped recording', () => {
    expect(secondsLeft(30 * MIN, NO_CAP)).toBe(0);
  });
});
