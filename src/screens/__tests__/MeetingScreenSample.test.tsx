import React from 'react';
import { Alert } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import MeetingScreen from '../MeetingScreen';
import { db } from '../../db/queries';
import { SAMPLE_ID, sampleBannerText } from '../../sample/sampleId';
import { deleteSample } from '../../sample/seedSample';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../sample/seedSample', () => ({
  seedSample: jest.fn(async () => ({ created: true })),
  deleteSample: jest.fn(async () => {}),
}));

const nav = {
  navigate: jest.fn(),
  goBack: jest.fn(),
  setOptions: jest.fn(),
  addListener: jest.fn(() => () => {}),
} as any;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  (db.ensureItems as jest.Mock).mockResolvedValue(undefined);
  (db.getMeeting as jest.Mock).mockImplementation(async (id: string) => ({
    id, title: 'Weekly check-in (sample)', createdAt: 1, durationMs: 64_000, status: 'done', tierUsed: 'free',
    language: 'en', audioPath: null, audioRetained: 1,
  }));
  (db.minutes as jest.Mock).mockResolvedValue([]);
  (db.items as jest.Mock).mockResolvedValue([]);
  (db.utterances as jest.Mock).mockResolvedValue([
    { id: 'u1', meetingId: SAMPLE_ID, startMs: 0, endMs: 1000, speakerId: null, text: 'Hello.' },
  ]);
  (db.segments as jest.Mock).mockResolvedValue([]);
  (db.speakers as jest.Mock).mockResolvedValue([]);
  (db.edits as jest.Mock).mockResolvedValue([]);
  (db.tagsFor as jest.Mock).mockResolvedValue([]);
  (db.marks as jest.Mock).mockResolvedValue([]);
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  (db.setSetting as jest.Mock).mockResolvedValue(undefined);
  (db.stageRates as jest.Mock).mockResolvedValue({});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function open(meetingId: string) {
  const route = { key: 'm', name: 'Meeting', params: { meetingId } } as any;
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<MeetingScreen navigation={nav} route={route} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    jest.advanceTimersByTime(1_000);
  });
  return tree;
}
const texts = (t: renderer.ReactTestRenderer) =>
  t.root.findAll(n => String(n.type) === 'Text').map(n => [n.props.children].flat().join(''));

describe('the sample meeting screen', () => {
  it('says what it is, in one line, and offers to delete it', async () => {
    const tree = await open(SAMPLE_ID);
    expect(texts(tree)).toContain(sampleBannerText);
    expect(sampleBannerText).toBe('Sample meeting — not from your microphone.');
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Delete sample' }).length).toBeGreaterThan(0);
    await act(async () => tree.unmount());
  });

  it('shows no banner on a meeting the person recorded', async () => {
    const tree = await open('3f2a9c1e-0b7d-4c55-9a52-61d0f4c0a1de');
    expect(texts(tree)).not.toContain(sampleBannerText);
    await act(async () => tree.unmount());
  });

  it('deleting asks first, removes the sample and leaves the screen', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await open(SAMPLE_ID);
    const del = tree.root.findAllByProps({ accessibilityLabel: 'Delete sample' })[0];
    await act(async () => del.props.onPress());
    expect(deleteSample).not.toHaveBeenCalled(); // nothing happens until confirmed
    const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    await act(async () => buttons.find(b => b.text === 'Delete sample')!.onPress!());
    expect(deleteSample).toHaveBeenCalledTimes(1);
    expect(nav.goBack).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());
  });

  it('opening the sample, or a meeting the person recorded, never opens the Pro sheet', async () => {
    for (const id of [SAMPLE_ID, '3f2a9c1e-0b7d-4c55-9a52-61d0f4c0a1de']) {
      const tree = await open(id);
      expect(nav.navigate).not.toHaveBeenCalledWith('Paywall', expect.anything());
      await act(async () => tree.unmount());
    }
  });
});
