import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, StyleSheet, Text } from 'react-native';
import SettingsScreen from '../SettingsScreen';
import { db } from '../../db/queries';
import Licence from '../../native/NativeLicence';
import AudioPipeline from '../../native/NativeAudioPipeline';
import ModelManager from '../../native/NativeModelManager';
import { useAllowanceStore } from '../../billing/allowance';

/**
 * F20 (D09, D21): the on-device model rows.
 *
 * A download started from the Paywall or Onboarding leaves a progress entry on this screen that
 * only Settings' own Get button ever cleared, so the row sat at "1.1 GB of 1.1 GB · 100%" with a
 * spinner. There is no native completion event, only the final (size, size) progress event.
 */
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
const list = ModelManager.list as unknown as jest.Mock;
const GB = 1_100_000_000;

const model = (installed: boolean) => ({
  id: 'writer',
  name: 'Qwen3 4B',
  purpose: 'Writes the summary',
  detail: 'On this phone',
  required: false,
  installed,
  sizeBytes: GB,
  needsSubscription: false,
  unsupportedReason: null,
});

let focusListeners: Array<() => void> = [];
const nav = {
  navigate: jest.fn(),
  goBack: jest.fn(),
  addListener: jest.fn((event: string, cb: () => void) => {
    if (event === 'focus') focusListeners.push(cb);
    return jest.fn();
  }),
} as any;

// Each Text's children joined, so "{name} ·{' '}{label}" reads as the one line a person sees.
const lines = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).map(n => [n.props.children].flat(Infinity).filter(c => typeof c === 'string').join(''));
const texts = lines;
const metaText = (tree: renderer.ReactTestRenderer) => lines(tree).find(t => /^[\d.,]+ (MB|GB)\b/.test(t));

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<SettingsScreen navigation={nav} route={{ key: 's', name: 'Settings', params: { section: 'storage' } } as any} />);
  });
  await act(async () => {});
  return tree;
}
const progress = (downloaded: number, total: number) =>
  act(async () => {
    (global as any).__TEST_EMIT__('onModelProgress', { id: 'writer', downloaded, total });
  });

beforeEach(() => {
  jest.clearAllMocks();
  focusListeners = [];
  useAllowanceStore.setState({ status: null });
  for (const fn of Object.values(db as unknown as Record<string, jest.Mock>)) {
    if (typeof fn?.mockResolvedValue === 'function') fn.mockResolvedValue(null);
  }
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  (Licence.allowance as unknown as jest.Mock).mockResolvedValue({
    limit: 5, used: 0, remaining: 5, period: '2026-10', resetsOn: '2026-11-01', paid: false,
  });
  list.mockResolvedValue(JSON.stringify([model(false)]));
});

test('a download in progress shows its bytes on the row', async () => {
  const tree = await render();
  await progress(GB / 2, GB);
  expect(metaText(tree)).toContain('of 1.1 GB · 50%');
  await act(async () => tree.unmount());
});

test('a download that finishes elsewhere clears the row and refreshes the list', async () => {
  const tree = await render();
  await progress(GB / 2, GB);
  expect(metaText(tree)).toContain('50%');
  const callsBefore = list.mock.calls.length;

  // The Paywall's download completes: the model is installed now, and the last event is (size, size).
  list.mockResolvedValue(JSON.stringify([model(true)]));
  await progress(GB, GB);

  expect(list.mock.calls.length).toBeGreaterThan(callsBefore);
  expect(texts(tree).join('|')).not.toContain('100%');
  expect(texts(tree)).toContain('ON THIS PHONE');
  await act(async () => tree.unmount());
});

test('even before the list says installed, a finished download does not stay at 100%', async () => {
  const tree = await render();
  await progress(GB, GB);
  expect(texts(tree).join('|')).not.toContain('100%');
  await act(async () => tree.unmount());
});

test('coming back to Settings clears a stale progress row and refreshes the list', async () => {
  const tree = await render();
  await progress(GB / 2, GB);
  expect(metaText(tree)).toContain('50%');
  const callsBefore = list.mock.calls.length;

  await act(async () => {
    focusListeners.forEach(cb => cb());
  });

  expect(list.mock.calls.length).toBeGreaterThan(callsBefore);
  expect(texts(tree).join('|')).not.toContain('50%');
  await act(async () => tree.unmount());
});

test('the model meta text shrinks and wraps instead of clipping its percentage', async () => {
  const tree = await render();
  await progress(GB / 2, GB);
  const node = tree.root
    .findAllByType(Text)
    .find(n => /^[\d.,]+ (MB|GB)\b/.test([n.props.children].flat(Infinity).join('')));
  expect(node).toBeDefined();
  const style = StyleSheet.flatten(node!.props.style) as Record<string, unknown>;
  expect(style.flexShrink).toBe(1);
  await act(async () => tree.unmount());
});

test('a model that turns out to be installed does not keep a stale progress entry for later', async () => {
  const tree = await render();
  await progress(GB / 2, GB);
  // Another model finishing makes the screen re-read the list, which now says the writer is in.
  list.mockResolvedValue(JSON.stringify([model(true)]));
  await act(async () => {
    (global as any).__TEST_EMIT__('onModelProgress', { id: 'other', downloaded: 5, total: 5 });
  });
  expect(texts(tree)).toContain('ON THIS PHONE');
  expect(metaText(tree)).toBe('1100 MB');
  await act(async () => tree.unmount());
});

test('no row names its model, only what it is for', async () => {
  const tree = await render();
  expect(lines(tree).some(t => t.includes('Qwen3 4B'))).toBe(false);
  expect(lines(tree)).toContain('Writes the summary');
  await act(async () => tree.unmount());
});

describe('features show their status, never a button', () => {
  const pro = (installed: boolean) => ({
    ...model(installed),
    id: 'whisper-small',
    name: 'Whisper small',
    purpose: 'Writes down what was said, more accurately',
    needsSubscription: true,
    sizeBytes: 190_085_487,
  });
  const anyButton = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll(n => typeof n.props.accessibilityLabel === 'string' && /^(Remove|Download) /.test(n.props.accessibilityLabel));

  test('no row offers Get or Remove', async () => {
    list.mockResolvedValue(JSON.stringify([model(true), pro(false)]));
    const tree = await render();
    expect(anyButton(tree)).toHaveLength(0);
    expect(texts(tree)).toEqual(expect.arrayContaining(['ON THIS PHONE', 'DOWNLOADS BY ITSELF']));
    await act(async () => tree.unmount());
  });

  test('on Free a Pro feature says it comes with Pro, and the row opens the Pro screen', async () => {
    const status = Licence.status as unknown as jest.Mock;
    const real = status.getMockImplementation()!;
    status.mockResolvedValue({ ...(await real()), paid: false });
    try {
      list.mockResolvedValue(JSON.stringify([pro(false)]));
      const tree = await render();
      expect(texts(tree)).toContain('COMES WITH PRO');
      const [row] = tree.root.findAllByProps({ accessibilityLabel: 'Writes down what was said, more accurately. Comes with Pro.' }, { deep: false });
      await act(async () => row.props.onPress());
      expect(nav.navigate).toHaveBeenCalledWith('Paywall');
      await act(async () => tree.unmount());
    } finally {
      status.mockImplementation(real);
    }
  });

  test("once Pro has lapsed, one button frees the space Pro's features take", async () => {
    const status = Licence.status as unknown as jest.Mock;
    const real = status.getMockImplementation()!;
    status.mockResolvedValue({ ...(await real()), paid: false });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    try {
      list.mockResolvedValue(JSON.stringify([pro(true)]));
      const tree = await render();
      const free = tree.root.findAll(n => n.props.label === "Remove Pro's features (190 MB)" && typeof n.props.onPress === 'function')[0];
      await act(async () => free.props.onPress());
      const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
      await act(async () => buttons.find(b => b.text === 'Remove')!.onPress!());
      expect(ModelManager.remove).toHaveBeenCalledWith('whisper-small');
      await act(async () => tree.unmount());
    } finally {
      status.mockImplementation(real);
      alert.mockRestore();
    }
  });
});
