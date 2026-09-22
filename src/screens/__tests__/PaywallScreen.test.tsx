import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { ScrollView } from 'react-native';
import PaywallScreen from '../PaywallScreen';
import { entitlement } from '../../billing/trial';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../billing/trial', () => ({
  __esModule: true,
  TRIAL_DAYS: 7,
  TRIAL_SUMMARIES: 3,
  entitlement: jest.fn(),
  startTrial: jest.fn(),
  markPaywallSeen: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../billing/subscription', () => ({
  __esModule: true,
  playAvailable: jest.fn().mockResolvedValue(false),
  playPlans: jest.fn().mockResolvedValue([]),
  playPrice: jest.fn().mockResolvedValue(null),
  buyWithPlay: jest.fn(),
  referencePrice: jest.fn(),
}));
jest.mock('../../native/NativeModelManager', () => ({
  __esModule: true,
  default: {
    list: jest.fn().mockResolvedValue('[]'),
    deviceFit: jest.fn().mockResolvedValue('{"freeBytes":100000000000}'),
    download: jest.fn(),
  },
}));
jest.mock('../../billing/SignInForm', () => () => null);

// The screen's `Pop` entrance animations start on mount and drive a native-driver frame loop.
// Left on real timers, those frames keep firing after this suite's environment is torn down, and
// the error they then throw is attributed to whichever suite the worker runs next — it was
// VoicesSection ("getNativeTagFromPublicInstance is not a function"), which passes on its own.
// Fake timers end the loop with the suite. Same convention as the other screen tests.
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

const nav = { navigate: jest.fn(), goBack: jest.fn() } as any;
const route = { key: 'paywall', name: 'Paywall', params: undefined } as any;

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<PaywallScreen navigation={nav} route={route} />);
  });
  return tree;
}

/**
 * Tapping "Try Pro free for 7 days" replaces the hero copy at the top of the scroll with the
 * confirmation — which is out of view, because the button is near the bottom. On the A07 it
 * looked like nothing had happened.
 */
describe('PaywallScreen and the trial button (Step 9)', () => {
  it('starting the trial scrolls back to the answer', async () => {
    (entitlement as jest.Mock).mockResolvedValue({
      paid: false,
      viaTrial: false,
      trial: { status: 'unstarted' },
      licence: null,
    });
    const tree = await render();
    const button = tree.root.findByProps({ label: 'Try Pro free for 7 days' });
    const scroll = tree.root.findByType(ScrollView);
    const scrollTo = jest.fn();
    scroll.instance.scrollTo = scrollTo;
    await act(async () => {
      button.props.onPress();
    });
    expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: true });
  });

  it('an ended trial is not offered one', async () => {
    (entitlement as jest.Mock).mockResolvedValue({
      paid: false,
      viaTrial: false,
      trial: { status: 'ended' },
      licence: null,
    });
    const tree = await render();
    expect(
      tree.root.findAllByProps({ label: 'Try Pro free for 7 days' }, { deep: false }),
    ).toHaveLength(0);
  });
});
