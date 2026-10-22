import { featureStatus } from '../featureStatus';

const row = (o: Partial<{ installed: boolean; needsSubscription: boolean; unsupportedReason: string | null }> = {}) => ({
  installed: false, needsSubscription: false, unsupportedReason: null, ...o,
});

describe('featureStatus', () => {
  it('on the phone is on the phone, whatever else is true', () => {
    expect(featureStatus(row({ installed: true, needsSubscription: true }), false, false)).toBe('ready');
  });
  it('a phone that cannot run it says so before anything else', () => {
    expect(featureStatus(row({ unsupportedReason: 'Needs 4 GB.' }), true, true)).toBe('unsupported');
  });
  it('downloading, while it is', () => {
    expect(featureStatus(row({ needsSubscription: true }), true, true)).toBe('downloading');
  });
  it('a Pro feature on Free comes with Pro', () => {
    expect(featureStatus(row({ needsSubscription: true }), false, false)).toBe('pro');
  });
  it('otherwise it is on its way by itself', () => {
    expect(featureStatus(row({ needsSubscription: true }), true, false)).toBe('waiting');
    expect(featureStatus(row(), false, false)).toBe('waiting');
  });
});
