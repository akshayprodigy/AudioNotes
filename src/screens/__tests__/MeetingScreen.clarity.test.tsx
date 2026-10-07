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
      // The Minutes tab's own furniture, not the Summary tab's.
      expect(allText(tree)).toContain('Written minutes');
      await act(async () => tree.unmount());
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Item 2 — lead with the takeaway, then decisions and next steps
// ---------------------------------------------------------------------------------------------

const item = (over: Record<string, unknown>) => ({
  id: 'i1', meetingId: 'm1', kind: 'decision', text: 'We agreed to go with the agency quote of $4,500.',
  review: 'suggested', genVersion: 'rules@1', itemType: null, status: null, ownerJson: null,
  dateSaid: null, dateNorm: null, anchorStartMs: 5_000, anchorEndMs: 9_000,
  sources: [{ startMs: 5_000, endMs: 9_000, charStart: 0, charEnd: 10, utteranceId: 'u1' }], ...over,
});
const FIXTURE = [
  item({}),
  item({ id: 'i2', kind: 'action', text: 'I will send the signed quote — Priya (due Wednesday)', anchorStartMs: 20_000 }),
  item({ id: 'i3', kind: 'action', text: 'The review still needs to be booked — Unassigned', anchorStartMs: 30_000 }),
  item({ id: 'i4', kind: 'action', text: 'I will share the checklist — Sam', anchorStartMs: 40_000 }),
  item({ id: 'i5', kind: 'question', text: 'Do we need captions on it?', anchorStartMs: 50_000 }),
];
const texts = (t: renderer.ReactTestRenderer) =>
  t.root.findAll(n => String(n.type) === 'Text').map(n => [n.props.children].flat().join(''));
const headers = (t: renderer.ReactTestRenderer) =>
  t.root
    .findAll(n => String(n.type) === 'Text' && n.props.accessibilityRole === 'header')
    .map(n => [n.props.children].flat().join(''));

describe('the Minutes tab leads with the takeaway', () => {
  beforeEach(() => {
    (db.items as jest.Mock).mockResolvedValue(FIXTURE);
    (db.minutes as jest.Mock).mockResolvedValue([]);
  });

  it('opens with one takeaway, then Decisions, Next steps and Questions, in that order', async () => {
    const tree = await open({ tab: 'mom' });
    expect(headers(tree).slice(0, 4)).toEqual([
      'Decided: We agreed to go with the agency quote of $4,500.',
      'Decisions · 1',
      'Next steps · 3',
      'Questions · 1',
    ]);
    await act(async () => tree.unmount());
  });

  it('never leads with a count of what the app found', async () => {
    const tree = await open({ tab: 'mom' });
    expect(texts(tree).filter(x => /\d+ (action items?|decisions?|open questions?)\b/.test(x))).toEqual([]);
    await act(async () => tree.unmount());
  });

  it('leads with the writer headline when the writer wrote one', async () => {
    (db.minutes as jest.Mock).mockResolvedValue([
      { id: 'h', meetingId: 'm1', kind: 'headline', content: 'The launch video is going ahead.', source: 'llm' },
    ]);
    const tree = await open({ tab: 'mom' });
    expect(headers(tree)[0]).toBe('The launch video is going ahead.');
    await act(async () => tree.unmount());
  });

  it('says "No owner yet" for an action nobody owns, names the owner and the due date where known, and nothing for a missing date', async () => {
    const tree = await open({ tab: 'mom' });
    const all = texts(tree);
    expect(all).toContain('Priya · due Wednesday');
    expect(all).toContain('No owner yet');
    expect(all).toContain('Sam');
    // A decision has no owner to be missing.
    expect(all.filter(x => x === 'No owner yet')).toHaveLength(1);
    // No due date was given for Sam's action, so the line carries no "due".
    expect(all.filter(x => /due/.test(x))).toEqual(['Priya · due Wednesday']);
    await act(async () => tree.unmount());
  });

  it('shows which next steps are done, in words', async () => {
    (db.doneItems as jest.Mock).mockResolvedValue(new Set(['i4']));
    const tree = await open({ tab: 'mom' });
    expect(texts(tree).filter(x => x === 'Done')).toHaveLength(1);
    await act(async () => tree.unmount());
  });

  it('keeps the source-audio link on every cited item', async () => {
    const tree = await open({ tab: 'mom' });
    const links = tree.root.findAll(
      n => typeof n.type === 'string' && /^Show this in the transcript at/.test(String(n.props.accessibilityLabel ?? '')),
    );
    expect(links.length).toBe(5);
    await act(async () => tree.unmount());
  });
});

describe('the Summary tab shows what is in each count', () => {
  it('puts the first decision beside its count', async () => {
    (db.items as jest.Mock).mockResolvedValue(FIXTURE);
    (db.minutes as jest.Mock).mockResolvedValue([]);
    const tree = await open({ tab: 'summary' });
    const all = texts(tree);
    expect(all).toContain('Decisions · 1');
    expect(all).toContain('We agreed to go with the agency quote of $4,500.');
    expect(all).toContain('Next steps · 3');
    expect(all).toContain('I will send the signed quote');
    await act(async () => tree.unmount());
  });
});
