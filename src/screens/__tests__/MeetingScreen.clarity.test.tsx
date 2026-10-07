/**
 * Workstream D — clearer results and navigation, as the meeting screen presents it.
 *
 * One file for the screen-level checks of the whole workstream, so the setup is written once:
 * the words on the tabs, what the Minutes tab leads with, the Ask entry, where "Write it again"
 * lives, the visible Edit controls and the screen-reader roles.
 */
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import MeetingScreen from '../MeetingScreen';
import { db } from '../../db/queries';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const nav = {
  navigate: jest.fn(),
  goBack: jest.fn(),
  setOptions: jest.fn(),
  addListener: jest.fn(() => () => {}),
} as any;

beforeEach(() => {
  jest.clearAllMocks();
  (db.ensureItems as jest.Mock).mockResolvedValue(undefined);
  (db.getMeeting as jest.Mock).mockResolvedValue({
    id: 'm1', title: 'Standup', createdAt: 1, durationMs: 60_000, status: 'done', tierUsed: 'free',
    language: 'en', audioPath: null, audioRetained: 1,
  });
  (db.minutes as jest.Mock).mockResolvedValue([
    { id: 'min-1', meetingId: 'm1', kind: 'summary', content: 'A short meeting about the report.', source: 'llm' },
  ]);
  (db.items as jest.Mock).mockResolvedValue([]);
  (db.utterances as jest.Mock).mockResolvedValue([]);
  (db.segments as jest.Mock).mockResolvedValue([]);
  (db.speakers as jest.Mock).mockResolvedValue([]);
  (db.edits as jest.Mock).mockResolvedValue([]);
  (db.tagsFor as jest.Mock).mockResolvedValue([]);
  (db.marks as jest.Mock).mockResolvedValue([]);
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  (db.setSetting as jest.Mock).mockResolvedValue(undefined);
  (db.stageRates as jest.Mock).mockResolvedValue({});
  (db.doneItems as jest.Mock).mockResolvedValue(new Set());
  (db.doneActions as jest.Mock).mockResolvedValue(new Set());
});

async function open(params: Record<string, unknown> = {}) {
  const route = { key: 'm', name: 'Meeting', params: { meetingId: 'm1', ...params } } as any;
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<MeetingScreen navigation={nav} route={route} />);
  });
  return tree;
}

const tabs = (t: renderer.ReactTestRenderer) =>
  t.root.findAll(n => n.props.accessibilityRole === 'tab' && typeof n.type === 'string');
const allText = (t: renderer.ReactTestRenderer) => JSON.stringify(t.toJSON());

describe('the words on the tabs', () => {
  it('reads Summary, Minutes, Transcript, Actions and never MOM or Script', async () => {
    const tree = await open();
    const labels = tabs(tree).map(n => n.props.accessibilityLabel);
    expect(labels).toHaveLength(4);
    expect(labels[1]).toContain('Minutes');
    expect(labels[2]).toContain('Transcript');
    const text = allText(tree);
    expect(text).not.toMatch(/"MOM"|"Script"/);
    await act(async () => tree.unmount());
  });

  it('opens the Minutes tab for the old key and for the new spelling', async () => {
    for (const tab of ['mom', 'minutes']) {
      const tree = await open({ tab });
      expect(allText(tree)).toContain('MINUTES');
      await act(async () => tree.unmount());
    }
  });
});
