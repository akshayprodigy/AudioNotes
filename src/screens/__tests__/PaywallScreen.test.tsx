import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import PaywallScreen from '../PaywallScreen';
import { entitlement } from '../../billing/trial';
import { buyWithPlay, playAvailable, playPlans } from '../../billing/subscription';
import type { PlayPlan } from '../../native/NativeBilling';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../billing/trial', () => ({
  __esModule: true,
  entitlement: jest.fn(),
  markPaywallSeen: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../billing/subscription', () => ({
  __esModule: true,
  playAvailable: jest.fn().mockResolvedValue(false),
  playPlans: jest.fn().mockResolvedValue([]),
  playPrice: jest.fn().mockResolvedValue(null),
  buyWithPlay: jest.fn(),
  referencePrice: jest.fn().mockReturnValue(null),
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

// Fake timers end the Pop entrance animations with the suite; see the other screen tests.
beforeEach(() => {
  jest.useFakeTimers();
  (entitlement as jest.Mock).mockResolvedValue({ paid: false, licence: null });
});
afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

const nav = { navigate: jest.fn(), goBack: jest.fn() } as any;

const plan = (o: Partial<PlayPlan>): PlayPlan => ({
  basePlanId: 'monthly', price: '₹299', priceMicros: 299e6, period: 'P1M',
  fullPrice: null, trialPeriod: null, trialCycles: 0, title: 'Verbale Pro', ...o,
});
const monthlyTrial = plan({ trialPeriod: 'P1W', trialCycles: 1 });
const annualTrial = plan({
  basePlanId: 'annual', price: '₹2,499', priceMicros: 2499e6, period: 'P1Y',
  trialPeriod: 'P1W', trialCycles: 1,
});
const monthly = plan({});
const annual = plan({ basePlanId: 'annual', price: '₹2,499', priceMicros: 2499e6, period: 'P1Y' });

async function render(params?: { from?: 'onboarding' }) {
  let tree!: renderer.ReactTestRenderer;
  const route = { key: 'paywall', name: 'Paywall', params } as any;
  await act(async () => {
    tree = renderer.create(<PaywallScreen navigation={nav} route={route} />);
  });
  await act(async () => {});
  return tree;
}

const texts = (tree: renderer.ReactTestRenderer) =>
  tree.root
    .findAll(n => typeof n.props.children === 'string')
    .map(n => n.props.children as string);

function sellsPlans(list: PlayPlan[]) {
  (playAvailable as jest.Mock).mockResolvedValue(true);
  (playPlans as jest.Mock).mockResolvedValue(list);
}

describe('PaywallScreen sells Play\'s free trial', () => {
  it('offers the trial on the preselected plan, with its terms', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    const tree = await render();
    expect(tree.root.findAllByProps({ label: 'Try it free for 7 days' }, { deep: false })).toHaveLength(1);
    expect(texts(tree)).toContain(
      'Free for 7 days, then ₹2,499 a year until you cancel. Cancel in Google Play before the trial ends and you pay nothing.',
    );
  });

  it('states the price when Play offers this account no trial', async () => {
    sellsPlans([monthly, annual]);
    const tree = await render();
    expect(tree.root.findAllByProps({ label: 'Subscribe — ₹2,499' }, { deep: false })).toHaveLength(1);
    expect(texts(tree).some(t => t.startsWith('Free for'))).toBe(false);
  });

  it('never offers the old in-app trial', async () => {
    const tree = await render();
    expect(tree.root.findAllByProps({ label: 'Try Pro free for 7 days' }, { deep: false })).toHaveLength(0);
  });

  it('buys the chosen base plan and says the trial started', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    (buyWithPlay as jest.Mock).mockResolvedValue({ paid: true });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await render();
    await act(async () => {
      tree.root.findByProps({ label: 'Try it free for 7 days' }).props.onPress();
    });
    expect(buyWithPlay).toHaveBeenCalledWith('annual');
    expect(alert.mock.calls[0][0]).toBe('Your free trial has started');
  });

  it('from first run, a purchase goes straight back to setup', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    (buyWithPlay as jest.Mock).mockResolvedValue({ paid: true });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await render({ from: 'onboarding' });
    await act(async () => {
      tree.root.findByProps({ label: 'Try it free for 7 days' }).props.onPress();
    });
    expect(nav.goBack).toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });
});
