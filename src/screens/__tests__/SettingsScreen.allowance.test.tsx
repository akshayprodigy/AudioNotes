import React from 'react';
import renderer, { act } from 'react-test-renderer';
import SettingsScreen from '../SettingsScreen';
import { db } from '../../db/queries';
import Licence from '../../native/NativeLicence';
import AudioPipeline from '../../native/NativeAudioPipeline';
import { useAllowanceStore } from '../../billing/allowance';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../billing/subscription', () => ({
  __esModule: true,
  ...jest.requireActual('../../billing/subscription'),
  playAvailable: jest.fn().mockResolvedValue(false),
  playPlans: jest.fn().mockResolvedValue([]),
  refreshIfNeeded: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../billing/SignInForm', () => () => null);
jest.mock('../settings/VoicesSection', () => () => null);

(AudioPipeline as any).supportedLanguages = jest.fn().mockResolvedValue('[]');
const allowance = Licence.allowance as unknown as jest.Mock;
const FREE = { limit: 5, used: 2, remaining: 3, period: '2026-10', resetsOn: '2026-11-01', paid: false };
const nav = { navigate: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;

const texts = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<SettingsScreen navigation={nav} route={{ key: 's', name: 'Settings', params: { section: 'plan' } } as any} />);
  });
  await act(async () => {});
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  useAllowanceStore.setState({ status: null });
  for (const fn of Object.values(db as unknown as Record<string, jest.Mock>)) {
    if (typeof fn?.mockResolvedValue === 'function') fn.mockResolvedValue(null);
  }
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  allowance.mockResolvedValue(FREE);
  (Licence.status as jest.Mock).mockResolvedValue({
    plan: 'free', state: 'none', paid: false, expiresAt: 0, account: null, lapsedCopy: '',
  });
  (Licence.baseUrl as jest.Mock).mockResolvedValue('https://licence.example');
});

test('Settings shows what is left and when it resets as one line under the plan name', async () => {
  const tree = await render();
  expect(texts(tree)).toContain('Free');
  expect(texts(tree)).not.toContain('Free allowance');
  expect(texts(tree)).toContain('3 of 5 left · resets 1 November');
  expect(texts(tree)).not.toContain('Imports and dictations count as meetings.');
  await act(async () => tree.unmount());
});

test('for Pro the page shows no allowance text at all', async () => {
  allowance.mockResolvedValue({ ...FREE, paid: true });
  (Licence.status as jest.Mock).mockResolvedValue({
    plan: 'pro', state: 'active', paid: true, expiresAt: 0, account: null, lapsedCopy: '',
  });
  const tree = await render();
  expect(texts(tree)).not.toContain('Free allowance');
  expect(texts(tree)).not.toContain('Unlimited with Pro');
  expect(texts(tree).some(t => /of 5 left|count as meetings/.test(t))).toBe(false);
  await act(async () => tree.unmount());
});

test('there is no allowance line until native has answered, rather than a guess', async () => {
  allowance.mockRejectedValue(new Error('not yet'));
  const tree = await render();
  expect(texts(tree).some(t => /of 5 left/.test(t))).toBe(false);
  await act(async () => tree.unmount());
});
