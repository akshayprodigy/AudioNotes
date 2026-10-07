import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import LibraryScreen from '../LibraryScreen';
import { db } from '../../db/queries';
import { useLibraryStore } from '../../state/libraryStore';
import { entitlement } from '../../billing/trial';
import { dayStart } from '../followUpData';
import { SAMPLE_ID } from '../../sample/sampleId';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../billing/trial', () => ({
  ...jest.requireActual('../../billing/trial'),
  entitlement: jest.fn(),
}));

/**
 * The Library's follow-up card (Workstream F). Pro only; three quiet rows (due or overdue actions,
 * decisions still open, notes to review), each a count and a preview, each into a filtered list.
 * The capture streak sits below it as a quiet line, never above it and never urgent.
 */
const nav = { navigate: jest.fn(), addListener: jest.fn(() => jest.fn()) } as never;
const route = { key: 'library', name: 'Library', params: undefined } as never;

const TODAY = dayStart(Date.now());
const DAY = 86_400_000;

const action = (over: Record<string, unknown> = {}) => ({
  meetingId: 'm1', meetingTitle: 'Standup', createdAt: 1, id: 'a1', content: 'Send the report — Priya (due Friday)',
  ownerJson: null, source: 'rule', anchorStartMs: 4000, dateNorm: TODAY - DAY, ...over,
});
const decision = (over: Record<string, unknown> = {}) => ({
  meetingId: 'm2', meetingTitle: 'Planning', createdAt: 2, id: 'd1', content: 'we will use the agency quote',
  status: 'open', itemType: 'agreement', anchorStartMs: 9000, ...over,
});
const reviewItem = (over: Record<string, unknown> = {}) => ({
  meetingId: 'm3', meetingTitle: 'Retro', createdAt: 3, id: 'r1', content: 'book the review', ...over,
});

async function show() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<LibraryScreen navigation={nav} route={route} />);
  });
  return tree;
}
const texts = (t: renderer.ReactTestRenderer) =>
  t.root.findAll(n => n.type === Text).map(n => [n.props.children].flat().join(''));
const row = (t: renderer.ReactTestRenderer, label: string) =>
  t.root.findAllByProps({ accessibilityLabel: label }).filter(n => typeof n.props.onPress === 'function');

beforeEach(() => {
  jest.clearAllMocks();
  (db.listMeetings as jest.Mock).mockResolvedValue([]);
  (db.allTags as jest.Mock).mockResolvedValue([]);
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  (db.archivedCount as jest.Mock).mockResolvedValue(0);
  (db.allActions as jest.Mock).mockResolvedValue([]);
  (db.allDecisions as jest.Mock).mockResolvedValue([]);
  (db.reviewItems as jest.Mock).mockResolvedValue([]);
  (db.doneItemIds as jest.Mock).mockResolvedValue(new Set<string>());
  (db.pendingMeetings as jest.Mock).mockResolvedValue([]);
  (entitlement as jest.Mock).mockResolvedValue({ paid: true });
  useLibraryStore.setState({
    backfillItems: jest.fn().mockResolvedValue(false),
    backfillSearch: jest.fn().mockResolvedValue(undefined),
    tag: null,
  });
});

describe('the follow-up card', () => {
  it('shows the three rows with a count and a preview of the first item', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([
      action({ id: 'a1', content: 'Send the report — Priya (due Friday)' }),
      action({ id: 'a2', content: 'Book the room', dateNorm: TODAY }),
    ]);
    (db.allDecisions as jest.Mock).mockResolvedValue([decision()]);
    (db.reviewItems as jest.Mock).mockResolvedValue([reviewItem(), reviewItem({ id: 'r2', content: 'second' })]);
    const tree = await show();
    const all = texts(tree);
    expect(all).toContain('FOLLOW-UP');
    expect(all).toContain('Due or overdue actions');
    expect(all).toContain('Decisions still open');
    expect(all).toContain('Notes to review');
    // Previews: the oldest due action first, owner and due tail dropped; decision capitalised.
    expect(all).toContain('Send the report');
    expect(all).toContain('We will use the agency quote');
    expect(all).toContain('Book the review');
    // Counts: two due, one decision, ONE meeting to review (two items in it).
    expect(row(tree, 'Due or overdue actions')[0].props.accessibilityHint).toMatch(/^2\./);
    expect(row(tree, 'Decisions still open')[0].props.accessibilityHint).toMatch(/^1\./);
    expect(row(tree, 'Notes to review')[0].props.accessibilityHint).toMatch(/^1\./);
    await act(async () => tree.unmount());
  });

  it('is absent for Free: no card, no rows, and the lists are not drawn', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    (db.allActions as jest.Mock).mockResolvedValue([action()]);
    (db.allDecisions as jest.Mock).mockResolvedValue([decision()]);
    (db.reviewItems as jest.Mock).mockResolvedValue([reviewItem()]);
    const tree = await show();
    const all = texts(tree);
    expect(all).not.toContain('FOLLOW-UP');
    expect(all).not.toContain('Due or overdue actions');
    expect(all).not.toContain('Decisions still open');
    expect(all).not.toContain('Notes to review');
    expect(row(tree, 'Open actions')).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  it('draws nothing when every count is zero, and no row with a zero count', async () => {
    const tree = await show();
    expect(texts(tree)).not.toContain('FOLLOW-UP');
    await act(async () => tree.unmount());

    (db.allDecisions as jest.Mock).mockResolvedValue([decision()]);
    const t2 = await show();
    expect(texts(t2)).toContain('Decisions still open');
    expect(texts(t2)).not.toContain('Due or overdue actions');
    expect(texts(t2)).not.toContain('Notes to review');
    await act(async () => t2.unmount());
  });

  it('does not count tomorrow, a phrase that could not be dated, a ticked action or an unread decision', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([
      action({ id: 'future', dateNorm: TODAY + DAY }),
      action({ id: 'phrase', dateNorm: null, content: 'Book it — Sam (due before Wednesday)' }),
      action({ id: 'ticked' }),
    ]);
    (db.doneItemIds as jest.Mock).mockResolvedValue(new Set(['m1\u0000ticked']));
    (db.allDecisions as jest.Mock).mockResolvedValue([
      decision({ status: 'contradicted' }),
      decision({ id: 'd2', status: 'withdrawn' }),
      decision({ id: 'd3', status: null, itemType: null }),
    ]);
    const tree = await show();
    const all = texts(tree);
    expect(all).not.toContain('Due or overdue actions');
    expect(all).not.toContain('Decisions still open');
    // The open-actions line still counts the two unticked ones: the card is the same card.
    expect(all).toContain('2 open actions');
    await act(async () => tree.unmount());
  });

  it('leaves the sample meeting out of every count', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([action({ meetingId: SAMPLE_ID })]);
    (db.allDecisions as jest.Mock).mockResolvedValue([decision({ meetingId: SAMPLE_ID })]);
    (db.reviewItems as jest.Mock).mockResolvedValue([reviewItem({ meetingId: SAMPLE_ID })]);
    const tree = await show();
    expect(texts(tree)).not.toContain('FOLLOW-UP');
    await act(async () => tree.unmount());
  });

  it('opens the due list, the decisions list, and the notes-to-review list', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([action()]);
    (db.allDecisions as jest.Mock).mockResolvedValue([decision()]);
    (db.reviewItems as jest.Mock).mockResolvedValue([reviewItem(), reviewItem({ meetingId: 'm4', id: 'r9' })]);
    const tree = await show();
    await act(async () => row(tree, 'Due or overdue actions')[0].props.onPress());
    expect((nav as any).navigate).toHaveBeenLastCalledWith('FollowUp', { kind: 'due' });
    await act(async () => row(tree, 'Decisions still open')[0].props.onPress());
    expect((nav as any).navigate).toHaveBeenLastCalledWith('FollowUp', { kind: 'decisions' });
    await act(async () => row(tree, 'Notes to review')[0].props.onPress());
    expect((nav as any).navigate).toHaveBeenLastCalledWith('FollowUp', { kind: 'review' });
    await act(async () => row(tree, 'Open actions')[0].props.onPress());
    expect((nav as any).navigate).toHaveBeenLastCalledWith('Actions');
    await act(async () => tree.unmount());
  });

  it('goes straight into the review queue when only one meeting is waiting', async () => {
    (db.reviewItems as jest.Mock).mockResolvedValue([reviewItem()]);
    const tree = await show();
    await act(async () => row(tree, 'Notes to review')[0].props.onPress());
    expect((nav as any).navigate).toHaveBeenLastCalledWith('Review', { meetingId: 'm3' });
    await act(async () => tree.unmount());
  });
});

