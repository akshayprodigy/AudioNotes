import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert, PermissionsAndroid } from 'react-native';
import RecordScreen from '../RecordScreen';
import { db } from '../../db/queries';
import Licence from '../../native/NativeLicence';
import AudioPipeline from '../../native/NativeAudioPipeline';
import { useRecordingStore } from '../../state/recordingStore';
import { refreshAllowance, useAllowanceStore } from '../../billing/allowance';
import { exhaustedCopy, remainingCopy } from '../../billing/allowanceCopy';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../billing/subscription', () => ({
  __esModule: true,
  playAvailable: jest.fn().mockResolvedValue(false),
  playPlans: jest.fn().mockResolvedValue([]),
  buyWithPlay: jest.fn(),
}));

const allowance = Licence.allowance as unknown as jest.Mock;
const FREE = { limit: 5, used: 2, remaining: 3, period: '2026-10', resetsOn: '2026-11-01', paid: false };
const nav = { navigate: jest.fn(), goBack: jest.fn(), reset: jest.fn() } as any;

const texts = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<RecordScreen navigation={nav} route={{ key: 'r', name: 'Record' } as any} />);
  });
  await act(async () => {});
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  useAllowanceStore.setState({ status: null });
  useRecordingStore.setState({ isRecording: false, sessionId: null });
  (db.getSetting as jest.Mock).mockImplementation(async (k: string) => (k === 'consentAck' ? '1' : null));
  (db.setSetting as jest.Mock).mockResolvedValue(undefined);
  (PermissionsAndroid.requestMultiple as jest.Mock | undefined)?.mockResolvedValue?.({});
  jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({
    'android.permission.RECORD_AUDIO': 'granted',
    'android.permission.POST_NOTIFICATIONS': 'granted',
  } as any);
  allowance.mockResolvedValue(FREE);
  // The screen's own idea of "Free" (the length hint) comes from the licence, not the ledger.
  (Licence.status as jest.Mock).mockResolvedValue({
    plan: 'free', state: 'none', paid: false, expiresAt: 0, account: null, lapsedCopy: '',
  });
});

/** The mic button is the one whose press starts a recording. */
const tapRecord = async (tree: renderer.ReactTestRenderer) => {
  const mic = tree.root.find(n => typeof n.props.onPress === 'function' && n.props.size === 148);
  await act(async () => {
    await mic.props.onPress();
  });
};

test('a Free phone with meetings left sees the quiet line and no card', async () => {
  const tree = await render();
  expect(texts(tree)).toContain(remainingCopy(3, 5, '2026-11-01'));
  expect(texts(tree).some(t => t.startsWith("You've used"))).toBe(false);
  expect(texts(tree)).toContain('Tap to start recording · up to 1 hour on Free');
  await act(async () => tree.unmount());
});

test('a Pro phone sees no allowance copy at all', async () => {
  allowance.mockResolvedValue({ ...FREE, paid: true });
  const tree = await render();
  expect(texts(tree).some(t => /free meetings|You've used/.test(t))).toBe(false);
  await act(async () => tree.unmount());
});

test('a spent allowance shows the exhausted card with an upgrade button before any tap', async () => {
  allowance.mockResolvedValue({ ...FREE, used: 5, remaining: 0 });
  const tree = await render();
  expect(texts(tree)).toContain(exhaustedCopy('2026-11-01'));
  await act(async () => tree.unmount());
});

test('a start that native refuses shows the exhausted card with the reset date it sent', async () => {
  (AudioPipeline.start as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error('2026-12-01'), { code: 'allowance_exhausted' }),
  );
  const tree = await render();
  await tapRecord(tree);
  expect(texts(tree)).toContain(exhaustedCopy('2026-12-01'));
  expect(useRecordingStore.getState().isRecording).toBe(false);
  await act(async () => tree.unmount());
});

test('the card is the way to Pro', async () => {
  allowance.mockResolvedValue({ ...FREE, used: 5, remaining: 0 });
  const tree = await render();
  // SoftButton is the element carrying the label and the handler; its Raised passes the press down.
  const upgrade = tree.root.find(n => n.props.label === 'Get Pro' && typeof n.props.onPress === 'function');
  await act(async () => upgrade.props.onPress());
  expect(nav.navigate).toHaveBeenCalledWith('Paywall');
  await act(async () => tree.unmount());
});

test('a start refused because an import is running says to finish the import first', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (AudioPipeline.start as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error('Finish the import first'), { code: 'import_in_progress' }),
  );
  const tree = await render();
  await tapRecord(tree);
  expect(alert).toHaveBeenCalledWith('Could not start recording', 'Finish the import first');
  await act(async () => tree.unmount());
});

test('while recording, the allowance line steps aside for the recording', async () => {
  (AudioPipeline.currentSession as jest.Mock).mockResolvedValueOnce({
    isRecording: true, meetingId: 'live', elapsedMs: 5000, silenced: false, paused: false,
  });
  const tree = await render();
  expect(useRecordingStore.getState().isRecording).toBe(true);
  expect(texts(tree).some(t => /free meetings left|You've used/.test(t))).toBe(false);
  await act(async () => tree.unmount());
});

test('buying Pro after a refusal takes the card away', async () => {
  (AudioPipeline.start as jest.Mock).mockRejectedValueOnce(
    Object.assign(new Error('2026-11-01'), { code: 'allowance_exhausted' }),
  );
  allowance.mockResolvedValue({ ...FREE, used: 5, remaining: 0 });
  const tree = await render();
  await tapRecord(tree);
  expect(texts(tree)).toContain(exhaustedCopy('2026-11-01'));
  allowance.mockResolvedValue({ ...FREE, used: 5, remaining: 0, paid: true });
  await act(async () => {
    await refreshAllowance();
  });
  expect(texts(tree).some(t => /You've used/.test(t))).toBe(false);
  await act(async () => tree.unmount());
});
