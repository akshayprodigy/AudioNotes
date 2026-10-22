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
const nav = { navigate: jest.fn(), push: jest.fn(), goBack: jest.fn(), addListener: jest.fn(() => jest.fn()) } as any;

const texts = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);

async function render(section?: string) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <SettingsScreen navigation={nav} route={{ key: 's', name: 'Settings', params: section ? { section } : undefined } as any} />,
    );
  });
  await act(async () => {});
  return tree;
}

const HEADINGS = ['Plan & account', 'Recording', 'Storage & features', 'Privacy', 'Appearance', 'About'];

beforeEach(() => {
  jest.clearAllMocks();
  useAllowanceStore.setState({ status: null });
  for (const fn of Object.values(db as unknown as Record<string, jest.Mock>)) {
    if (typeof fn?.mockResolvedValue === 'function') fn.mockResolvedValue(null);
  }
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  allowance.mockResolvedValue(FREE);
});

test('Settings opens on six headings and nothing else', async () => {
  const tree = await render();
  expect(texts(tree)).toEqual(expect.arrayContaining(['Settings', ...HEADINGS]));
  expect(texts(tree)).not.toContain('SUBSCRIPTION');
  expect(texts(tree)).not.toContain('FEATURES ON THIS PHONE');
  await act(async () => tree.unmount());
});

test('a heading opens its own page', async () => {
  const tree = await render();
  const [row] = tree.root.findAllByProps({ accessibilityLabel: 'Recording' }, { deep: false });
  await act(async () => row.find(n => typeof n.props.onPress === 'function').props.onPress());
  expect(nav.push).toHaveBeenCalledWith('Settings', { section: 'recording' });
  await act(async () => tree.unmount());
});

test('a page shows its own sections and no others, under its own title', async () => {
  const tree = await render('privacy');
  const t = texts(tree);
  expect(t).toContain('Privacy');
  expect(t).toContain('PRIVACY');
  expect(t).not.toContain('SUBSCRIPTION');
  expect(t).not.toContain('FEATURES ON THIS PHONE');
  expect(t).not.toContain('Recording');
  await act(async () => tree.unmount());
});

test('Recording gathers announcing, vocabulary and the language', async () => {
  const tree = await render('recording');
  expect(texts(tree)).toEqual(expect.arrayContaining(['BEFORE YOU RECORD', 'VOCABULARY', 'TRANSCRIPTION']));
  await act(async () => tree.unmount());
});
