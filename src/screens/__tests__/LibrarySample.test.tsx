import React from 'react';
import renderer, { act } from 'react-test-renderer';
import LibraryScreen from '../LibraryScreen';
import ProNudgeCard from '../ProNudgeCard';
import { db } from '../../db/queries';
import { useLibraryStore } from '../../state/libraryStore';
import { entitlement } from '../../billing/trial';
import ModelManager from '../../native/NativeModelManager';
import { SAMPLE_ID } from '../../sample/sampleId';
import { seedSample } from '../../sample/seedSample';
import { resetDownloadsForTest } from '../../setup/essentialDownload';

jest.mock('../../db/queries');
jest.mock('../../sample/seedSample', () => ({
  seedSample: jest.fn(async () => ({ created: true })),
  deleteSample: jest.fn(async () => {}),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../billing/trial', () => ({
  ...jest.requireActual('../../billing/trial'),
  entitlement: jest.fn(),
}));

const nav = { navigate: jest.fn(), addListener: jest.fn(() => jest.fn()) } as never;
const route = { key: 'library', name: 'Library', params: undefined } as never;

const meeting = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Meeting ${id}`,
  createdAt: Date.now(),
  durationMs: 600_000,
  language: 'en',
  status: 'done',
  tierUsed: 'free',
  audioRetained: 1,
  summaryLine: null,
  mode: null,
  ...over,
});
const sample = () => meeting(SAMPLE_ID, { title: 'Weekly check-in (sample)', durationMs: 64_000 });

async function show() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<LibraryScreen navigation={nav} route={route} />);
  });
  return tree;
}
const texts = (t: renderer.ReactTestRenderer) =>
  t.root.findAll(n => String(n.type) === 'Text').map(n => [n.props.children].flat().join(''));

beforeEach(() => {
  jest.clearAllMocks();
  (db.listMeetings as jest.Mock).mockResolvedValue([]);
  (db.allTags as jest.Mock).mockResolvedValue([]);
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  (db.setSetting as jest.Mock).mockResolvedValue(undefined);
  (db.archivedCount as jest.Mock).mockResolvedValue(0);
  (db.allActions as jest.Mock).mockResolvedValue([]);
  (db.doneItemIds as jest.Mock).mockResolvedValue(new Set<string>());
  (db.pendingMeetings as jest.Mock).mockResolvedValue([]);
  (entitlement as jest.Mock).mockResolvedValue({ paid: false });
  useLibraryStore.setState({
    backfillItems: jest.fn(async () => false),
    backfillSearch: jest.fn(async () => {}),
    tag: null,
    meetings: [],
  });
  resetDownloadsForTest();
});

describe('the sample in the Library', () => {
  it('is labelled SAMPLE, but is not counted: the header still says nothing is recorded', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([sample()]);
    const tree = await show();
    const t = texts(tree);
    expect(t).toContain('SAMPLE');
    expect(t).toContain('Nothing recorded yet');
    expect(t.some(x => /\d+ saved/.test(x))).toBe(false);
    // The sample card is the welcome: the big empty panel would contradict it.
    expect(t).not.toContain('No meetings yet');
    await act(async () => tree.unmount());
  });

  it('shows the big empty panel only when there is no meeting at all', async () => {
    const tree = await show();
    expect(texts(tree)).toContain('No meetings yet');
    await act(async () => tree.unmount());
  });

  it('a done meeting card has no READY chip, no initials tile; a processing one keeps its chip', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([
      meeting('a', { title: 'Weekly Catchup' }),
      meeting('b', { status: 'transcribing' }),
    ]);
    const tree = await show();
    const t = texts(tree);
    expect(t).not.toContain('READY');
    expect(t).not.toContain('WC');
    expect(t.some(x => /TRANSCRIBING/.test(x))).toBe(true);
    await act(async () => tree.unmount());
  });

  it('a done non-sample small card has no empty badges row', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([meeting('a'), meeting('b'), meeting('c')]);
    const tree = await show();
    expect(tree.root.findAll(n => n.props.testID === 'small-badges')).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  it('the Settings header button wears the gear', async () => {
    const tree = await show();
    const btn = tree.root.findAll(n => n.props.label === 'Settings' && n.props.icon)[0];
    expect(btn.props.icon).toBe('gear');
    await act(async () => tree.unmount());
  });

  it("counts only the person's own meetings, and their minutes, in the header", async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([
      meeting('a', { durationMs: 600_000 }),
      sample(),
      meeting('b', { durationMs: 1_200_000 }),
    ]);
    const tree = await show();
    const strip = tree.root.findAll(n => n.props.testID === 'library-summary')[0];
    expect(strip.props.accessibilityLabel).toContain('2 meetings saved. 30 min captured');
    await act(async () => tree.unmount());
  });

  it('does not count towards the Pro offer: four finished meetings and the sample is not five', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([
      meeting('a'), meeting('b'), meeting('c'), meeting('d'), sample(),
    ]);
    const tree = await show();
    expect(tree.root.findAllByType(ProNudgeCard)).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  it('...while a fifth real meeting does bring the offer, so the test above is not vacuous', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([
      meeting('a'), meeting('b'), meeting('c'), meeting('d'), meeting('e'), sample(),
    ]);
    const tree = await show();
    expect(tree.root.findAllByType(ProNudgeCard)).toHaveLength(1);
    await act(async () => tree.unmount());
  });

  it('is not a day of capture: a sample dated today does not start a streak', async () => {
    const yesterday = Date.now() - 86_400_000;
    (db.listMeetings as jest.Mock).mockResolvedValue([sample(), meeting('a', { createdAt: yesterday })]);
    const tree = await show();
    expect(texts(tree).some(x => /days in a row/.test(x))).toBe(false);
    await act(async () => tree.unmount());
  });

  it('offers "See the sample again" only when it is not in the library, and seeds then opens it', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([meeting('a')]);
    const tree = await show();
    const again = tree.root.findByProps({ accessibilityLabel: 'See the sample again' });
    await act(async () => again.props.onPress());
    expect(seedSample).toHaveBeenCalledTimes(1);
    expect((nav as any).navigate).toHaveBeenCalledWith('Meeting', { meetingId: SAMPLE_ID });
    await act(async () => tree.unmount());

    (db.listMeetings as jest.Mock).mockResolvedValue([meeting('a'), sample()]);
    const tree2 = await show();
    expect(tree2.root.findAllByProps({ accessibilityLabel: 'See the sample again' })).toHaveLength(0);
    await act(async () => tree2.unmount());
  });
});

describe('the readiness card in the Library', () => {
  const MB = 1_000_000;
  const catalog = (held: number) =>
    JSON.stringify([
      { id: 'vad', purpose: 'Voice detection', kind: 'vad', required: true, installed: true, sizeBytes: 2 * MB, heldBytes: 2 * MB },
      { id: 'asr', purpose: 'Speech to text', kind: 'asr', required: true, installed: false, sizeBytes: 60 * MB, heldBytes: held },
      { id: 'diar', purpose: 'Who spoke', kind: 'diar', required: true, installed: false, sizeBytes: 52 * MB, heldBytes: 0 },
    ]);

  beforeEach(() => {
    resetDownloadsForTest();
    (ModelManager as any).deviceFit = jest.fn(async () => JSON.stringify({ cpuReason: null, freeBytes: 10_000 * MB }));
  });

  it('carries on an interrupted download by itself, saying how far it got', async () => {
    (ModelManager.list as jest.Mock).mockResolvedValue(catalog(30 * MB));
    (ModelManager.download as jest.Mock).mockImplementation(() => new Promise(() => {}));
    (db.listMeetings as jest.Mock).mockResolvedValue([meeting('a')]);
    const tree = await show();
    // Only what is not installed, in catalog order: native resumes the partial file.
    expect((ModelManager.download as jest.Mock).mock.calls.map(c => c[0])).toEqual(['asr']);
    expect(texts(tree)).toContain('Downloading — 28% of 114 MB');
    await act(async () => tree.unmount());
  });

  it('draws nothing once every essential model is on the phone', async () => {
    (ModelManager.list as jest.Mock).mockResolvedValue(
      JSON.stringify([{ id: 'vad', purpose: 'v', kind: 'vad', required: true, installed: true, sizeBytes: 2 * MB }]),
    );
    const tree = await show();
    expect(texts(tree).some(x => /Finish setup|Setup stopped|Downloading —/.test(x))).toBe(false);
    await act(async () => tree.unmount());
  });
});
