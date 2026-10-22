import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import PaywallScreen from '../PaywallScreen';
import { entitlement } from '../../billing/trial';
import { buyWithPlay, playAvailable, playPlans, restorePlayPurchase } from '../../billing/subscription';
import type { PlayPlan } from '../../native/NativeBilling';
import { runProModels, useProModelsStore } from '../../setup/proModels';

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
  restorePlayPurchase: jest.fn(),
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
jest.mock('../../setup/proModels', () => {
  const { create } = jest.requireActual('zustand');
  return {
    __esModule: true,
    useProModelsStore: create(() => ({ running: false, error: null, downloaded: 0, total: 0 })),
    runProModels: jest.fn(() => Promise.resolve(true)),
  };
});

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

async function render(params?: { from?: 'onboarding' | 'export' }) {
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
    expect(tree.root.findAllByProps({ label: 'Subscribe — ₹2,499 a year' }, { deep: false })).toHaveLength(1);
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

  it('a payment the server has not confirmed says "Payment received", not failed', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    (buyWithPlay as jest.Mock).mockResolvedValue({ paid: false, pendingServer: true });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await render();
    await act(async () => {
      tree.root.findByProps({ label: 'Try it free for 7 days' }).props.onPress();
    });
    expect(alert.mock.calls[0][0]).toBe('Payment received');
  });

  it('offers Restore to somebody who already subscribed', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    (restorePlayPurchase as jest.Mock).mockResolvedValue({ paid: true });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await render();
    await act(async () => {
      tree.root.findByProps({ label: 'Restore purchase' }).props.onPress();
    });
    expect(restorePlayPurchase).toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toBe('Subscription restored');
  });
});

describe('PaywallScreen leads with meetings (F08)', () => {
  it('states the Free allowance with the headline and the explainer, and never fifteen minutes', async () => {
    const tree = await render();
    const all = texts(tree).join('\n');
    expect(all).toContain('Free: 5 meetings each month · up to 1 hour each.');
    expect(all).toContain('Imports and dictations count as meetings.');
    expect(all).not.toMatch(/15 min|fifteen/i);
  });

  it('lists more meetings first, before any model or summary', async () => {
    const tree = await render();
    const titles = texts(tree);
    const first = titles.indexOf('More meetings, any length');
    expect(first).toBeGreaterThanOrEqual(0);
    for (const later of ['Search by meaning', 'Ask the meeting', 'The larger transcriber']) {
      expect(titles.indexOf(later)).toBeGreaterThan(first);
    }
  });

  it('says keyword search is free and sells meaning', async () => {
    const tree = await render();
    const all = texts(tree).join('\n');
    expect(all).toContain('Search by meaning');
    expect(all).toContain('Search finds every word across your meetings for free.');
    expect(all).not.toContain('Search everything you have recorded');
  });

  it('does not advertise reminders or a digest, which are not built', async () => {
    const tree = await render();
    expect(texts(tree).join('\n')).not.toMatch(/reminder|digest/i);
  });
});

describe('PaywallScreen says payments are not refundable where it is bought', () => {
  const trialLine = "Payments aren't refundable — the free trial is for trying it.";
  const plainLine = "Payments aren't refundable.";

  it('with a trial plan, says the free trial is for trying it', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    const tree = await render();
    expect(texts(tree)).toContain(trialLine);
    expect(texts(tree)).not.toContain(plainLine);
  });

  it('with no trial, just says payments are not refundable', async () => {
    sellsPlans([monthly, annual]);
    const tree = await render();
    expect(texts(tree)).toContain(plainLine);
    expect(texts(tree)).not.toContain(trialLine);
  });

  it('once bought, says neither', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    (entitlement as jest.Mock).mockResolvedValue({ paid: true, licence: { paid: true } });
    const tree = await render();
    expect(texts(tree)).not.toContain(trialLine);
    expect(texts(tree)).not.toContain(plainLine);
  });
});

describe('PaywallScreen can be bought from without scrolling', () => {
  const { ScrollView } = require('react-native');

  it('keeps the buy button and the trial terms outside the scroll', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    const tree = await render();
    const scroll = tree.root.findByType(ScrollView);
    expect(tree.root.findAllByProps({ label: 'Try it free for 7 days' }, { deep: false })).toHaveLength(1);
    expect(scroll.findAllByProps({ label: 'Try it free for 7 days' }, { deep: false })).toHaveLength(0);
    const terms = 'Free for 7 days, then ₹2,499 a year until you cancel. Cancel in Google Play before the trial ends and you pay nothing.';
    expect(texts(tree)).toContain(terms);
    expect(scroll.findAll(n => n.props.children === terms)).toHaveLength(0);
  });

  it('keeps Restore inside the scroll, not in the pinned dock', async () => {
    sellsPlans([monthlyTrial, annualTrial]);
    const tree = await render();
    const scroll = tree.root.findByType(ScrollView);
    expect(scroll.findAllByProps({ label: 'Restore purchase' }, { deep: false })).toHaveLength(1);
  });

  const highlightKeys = (tree: renderer.ReactTestRenderer) =>
    tree.root
      .findAll(n => typeof n.props.testID === 'string' && n.props.testID.startsWith('highlight-'), { deep: false })
      .map(n => n.props.testID as string);

  it('leads with three highlights, meetings first', async () => {
    const tree = await render();
    expect(highlightKeys(tree)).toEqual(['highlight-meetings', 'highlight-writer', 'highlight-export']);
  });

  it('sent by the export gate, export leads', async () => {
    const tree = await render({ from: 'export' });
    expect(highlightKeys(tree)[0]).toBe('highlight-export');
  });

  it('still lists every Pro feature below the highlights', async () => {
    const tree = await render();
    const all = texts(tree);
    for (const title of ['Export: MP3, PDF, SRT, Markdown, text', 'More meetings, any length', 'The larger transcriber']) {
      expect(all).toContain(title);
    }
  });
});

describe("after buying, Pro's models download in the background", () => {
  const idle = { running: false, error: null, downloaded: 0, total: 0 };
  afterEach(() => useProModelsStore.setState(idle));
  const closes = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll(n => n.props.label === 'Close' && typeof n.props.onPress === 'function');

  async function buy(params?: { from?: 'onboarding' | 'export' }) {
    sellsPlans([monthlyTrial, annualTrial]);
    (buyWithPlay as jest.Mock).mockResolvedValue({ paid: true });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await render(params);
    (entitlement as jest.Mock).mockResolvedValue({ paid: true, licence: { paid: true } });
    await act(async () => {
      tree.root.findByProps({ label: 'Try it free for 7 days' }).props.onPress();
    });
    await act(async () => {});
    return { tree, alert };
  }

  it('buying starts the download at once, and says it carries on in the background', async () => {
    const { tree, alert } = await buy();
    expect(runProModels).toHaveBeenCalled();
    expect(alert.mock.calls[0][1]).toContain('carries on in the background');
    await act(async () => tree.unmount());
  });

  it('the buyer can leave while it downloads, and is told so', async () => {
    const { tree } = await buy();
    await act(async () => {
      useProModelsStore.setState({ running: true, error: null, downloaded: 1, total: 100 });
    });
    expect(closes(tree).length).toBeGreaterThan(0);
    expect(texts(tree)).toContain('You can leave this screen. The download carries on in the background while you use the app.');
    await act(async () => tree.unmount());
  });

  it('a failed download says why and offers Try again', async () => {
    const { tree } = await buy();
    (runProModels as jest.Mock).mockClear();
    await act(async () => {
      useProModelsStore.setState({ running: false, error: 'No connection', downloaded: 0, total: 0 });
    });
    expect(texts(tree)).toContain("Pro's models did not finish downloading: No connection");
    await act(async () => {
      tree.root.findAll(n => n.props.label === 'Try again' && typeof n.props.onPress === 'function')[0].props.onPress();
    });
    expect(runProModels).toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('opened on Pro, the screen picks up a download that stopped', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true, licence: { paid: true } });
    const tree = await render();
    expect(runProModels).toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('from first run, a purchase leaves the download to setup', async () => {
    const { tree } = await buy({ from: 'onboarding' });
    expect(nav.goBack).toHaveBeenCalled();
    expect(runProModels).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });
});
