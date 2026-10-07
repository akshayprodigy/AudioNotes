import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { PermissionsAndroid } from 'react-native';
import RecordScreen from '../RecordScreen';
import { db } from '../../db/queries';
import Licence from '../../native/NativeLicence';
import AudioPipeline from '../../native/NativeAudioPipeline';
import ModelManager from '../../native/NativeModelManager';
import { useRecordingStore } from '../../state/recordingStore';
import { useAllowanceStore } from '../../billing/allowance';
import { freeHeadline } from '../../billing/allowanceCopy';
import { SAMPLE_ID } from '../../sample/sampleId';
import { resetDownloadsForTest } from '../../setup/essentialDownload';

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

const MB = 1_000_000;
const FREE = { limit: 5, used: 0, remaining: 5, period: '2026-10', resetsOn: '2026-11-01', paid: false };
const nav = { navigate: jest.fn(), goBack: jest.fn(), reset: jest.fn() } as any;
const catalog = (installed: boolean, held = 0) =>
  JSON.stringify([
    { id: 'asr', purpose: 'Speech to text', kind: 'asr', required: true, installed, sizeBytes: 114 * MB, heldBytes: installed ? 114 * MB : held },
  ]);
const texts = (t: renderer.ReactTestRenderer) =>
  t.root.findAll(n => String(n.type) === 'Text').map(n => [n.props.children].flat().join(''));
const meeting = (id: string) => ({ id, title: id, createdAt: 1, durationMs: 60_000, status: 'done' });

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
  resetDownloadsForTest();
  useAllowanceStore.setState({ status: null });
  useRecordingStore.setState({ isRecording: false, sessionId: null });
  (db.getSetting as jest.Mock).mockImplementation(async (k: string) => (k === 'consentAck' ? '1' : null));
  (db.setSetting as jest.Mock).mockResolvedValue(undefined);
  (db.listMeetings as jest.Mock).mockResolvedValue([]);
  jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({} as any);
  (Licence.allowance as jest.Mock).mockResolvedValue(FREE);
  (Licence.status as jest.Mock).mockResolvedValue({ plan: 'free', state: 'none', paid: false, expiresAt: 0, account: null, lapsedCopy: '' });
  (ModelManager.list as jest.Mock).mockResolvedValue(catalog(true));
  (ModelManager as any).deviceFit = jest.fn(async () => JSON.stringify({ cpuReason: null, freeBytes: 10_000 * MB }));
});

describe('the allowance and language note before the first recording', () => {
  it('shows English and the Free allowance when nothing has been recorded', async () => {
    const tree = await render();
    expect(texts(tree)).toContain(`Verbale works in English. ${freeHeadline}`);
    await act(async () => tree.unmount());
  });

  it('is not spent by the sample: it is not from the microphone', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([meeting(SAMPLE_ID)]);
    const tree = await render();
    expect(texts(tree)).toContain(`Verbale works in English. ${freeHeadline}`);
    await act(async () => tree.unmount());
  });

  it('goes once the person has a real meeting', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([meeting('3f2a9c1e-0b7d-4c55-9a52-61d0f4c0a1de')]);
    const tree = await render();
    expect(texts(tree).some(t => t.startsWith('Verbale works in English'))).toBe(false);
    await act(async () => tree.unmount());
  });

  it('says only the language to Pro', async () => {
    (Licence.allowance as jest.Mock).mockResolvedValue({ ...FREE, paid: true });
    const tree = await render();
    expect(texts(tree)).toContain('Verbale works in English.');
    expect(texts(tree).some(t => t.includes(freeHeadline))).toBe(false);
    await act(async () => tree.unmount());
  });
});

describe('the readiness card on the recorder', () => {
  it('offers to resume an interrupted setup, and the recorder is still there to use', async () => {
    (ModelManager.list as jest.Mock).mockResolvedValue(catalog(false, 57 * MB));
    const tree = await render();
    expect(texts(tree)).toContain('Finish setup — 50% of 114 MB downloaded');
    await act(async () => tree.root.findByProps({ accessibilityLabel: 'Resume setup' }).props.onPress());
    expect(ModelManager.download).toHaveBeenCalledWith('asr');
    await act(async () => tree.unmount());
  });

  it('is absent once setup is complete', async () => {
    const tree = await render();
    expect(texts(tree).some(t => /Finish setup|Setup stopped/.test(t))).toBe(false);
    await act(async () => tree.unmount());
  });

  it('is absent while recording', async () => {
    (ModelManager.list as jest.Mock).mockResolvedValue(catalog(false, 57 * MB));
    // The screen reads the live session from native on mount, so that is what has to say so.
    (AudioPipeline.currentSession as jest.Mock).mockResolvedValueOnce({
      isRecording: true, meetingId: 's', elapsedMs: 1000, silenced: false, paused: false,
    });
    const tree = await render();
    expect(texts(tree).some(t => /Finish setup/.test(t))).toBe(false);
    await act(async () => tree.unmount());
  });
});
