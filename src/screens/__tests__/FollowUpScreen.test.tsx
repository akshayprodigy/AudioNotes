import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import FollowUpScreen from '../FollowUpScreen';
import { db } from '../../db/queries';
import { entitlement } from '../../billing/trial';
import { dayStart } from '../followUpData';
import { dayLabel } from '../../pipeline/dateNorm';

jest.mock('../../db/queries');
jest.mock('../../billing/trial', () => ({ __esModule: true, entitlement: jest.fn() }));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => require('react').useEffect(cb, [cb]),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const nav = { navigate: jest.fn(), goBack: jest.fn() } as any;
const TODAY = dayStart(Date.now());
const DAY = 86_400_000;

const action = (over: Record<string, unknown> = {}) => ({
  meetingId: 'm1', meetingTitle: 'Standup', createdAt: 1, id: 'a1', content: 'Send the report — Priya (due Friday)',
  ownerJson: null, source: 'rule', anchorStartMs: 4000, dateNorm: TODAY - DAY, ...over,
});

async function show(kind: 'due' | 'decisions' | 'review') {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <FollowUpScreen navigation={nav} route={{ key: 'f', name: 'FollowUp', params: { kind } } as any} />,
    );
  });
  return tree;
}
const texts = (t: renderer.ReactTestRenderer) =>
  t.root.findAll(n => n.type === Text).map(n => [n.props.children].flat().join(''));
const press = (t: renderer.ReactTestRenderer, label: string) =>
  t.root.findAllByProps({ accessibilityLabel: label }).filter(n => typeof n.props.onPress === 'function')[0].props.onPress();

beforeEach(() => {
  jest.clearAllMocks();
  (entitlement as jest.Mock).mockResolvedValue({ paid: true });
  (db.allActions as jest.Mock).mockResolvedValue([]);
  (db.allDecisions as jest.Mock).mockResolvedValue([]);
  (db.reviewItems as jest.Mock).mockResolvedValue([]);
  (db.doneItemIds as jest.Mock).mockResolvedValue(new Set<string>());
  (db.setItemDone as jest.Mock).mockResolvedValue(undefined);
});

describe('due or overdue', () => {
  it('lists open actions that are due, most overdue first, with the day each was due', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([
      action({ id: 'b', content: 'Second one', dateNorm: TODAY }),
      action({ id: 'a', content: 'First one', dateNorm: TODAY - 5 * DAY }),
      action({ id: 'later', content: 'Next week', dateNorm: TODAY + 7 * DAY }),
    ]);
    const tree = await show('due');
    const all = texts(tree);
    expect(all.indexOf('First one')).toBeGreaterThanOrEqual(0);
    expect(all.indexOf('Second one')).toBeGreaterThan(all.indexOf('First one'));
    expect(all).not.toContain('Next week');
    // One row says today; the older one names its day (not "today", not blank).
    expect(all.filter(x => /Due today/.test(x))).toHaveLength(1);
    expect(all.some(x => x.includes(`Due ${dayLabel(TODAY - 5 * DAY)}`))).toBe(true);
    await act(async () => tree.unmount());
  });

  it('opens the meeting at the moment the action was said, and plays from it', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([action({ anchorStartMs: 4000 })]);
    const tree = await show('due');
    await act(async () => press(tree, 'Open the meeting this came from: Send the report'));
    expect(nav.navigate).toHaveBeenCalledWith('Meeting', { meetingId: 'm1', tab: 'transcript', atMs: 4000, play: true });
    await act(async () => tree.unmount());
  });

  it('opens a typed action (no moment) on the Actions tab, and treats 0 ms as a real moment', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([
      action({ id: 'typed', content: 'Typed one', anchorStartMs: null }),
      action({ id: 'zero', content: 'At the start', anchorStartMs: 0 }),
    ]);
    const tree = await show('due');
    await act(async () => press(tree, 'Open the meeting this came from: Typed one'));
    expect(nav.navigate).toHaveBeenLastCalledWith('Meeting', { meetingId: 'm1', tab: 'actions' });
    await act(async () => press(tree, 'Open the meeting this came from: At the start'));
    expect(nav.navigate).toHaveBeenLastCalledWith('Meeting', { meetingId: 'm1', tab: 'transcript', atMs: 0, play: true });
    await act(async () => tree.unmount());
  });

  it('ticks in place through the same item_done write the Actions screen uses', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([action()]);
    const tree = await show('due');
    await act(async () => press(tree, 'Send the report'));
    expect(db.setItemDone).toHaveBeenCalledWith('m1', 'a1', true);
    // The row stays, struck through, so a mis-tap can be undone; a second tap unticks.
    await act(async () => press(tree, 'Send the report'));
    expect(db.setItemDone).toHaveBeenLastCalledWith('m1', 'a1', false);
    await act(async () => tree.unmount());
  });

  it('shows what is ticked as already done: a ticked action is not in the list at all', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([action()]);
    (db.doneItemIds as jest.Mock).mockResolvedValue(new Set(['m1\u0000a1']));
    const tree = await show('due');
    expect(texts(tree)).toContain('Nothing is due');
    await act(async () => tree.unmount());
  });

  it('sends Free to the paywall', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const tree = await show('due');
    expect(nav.navigate).toHaveBeenCalledWith('Paywall');
    await act(async () => tree.unmount());
  });
});

describe('decisions still open', () => {
  const decision = (over: Record<string, unknown> = {}) => ({
    meetingId: 'm2', meetingTitle: 'Planning', createdAt: 2, id: 'd1', content: 'we will use the agency quote',
    status: 'open', itemType: 'agreement', anchorStartMs: 9000, ...over,
  });

  it('lists open and qualified decisions only, and opens one at its moment', async () => {
    (db.allDecisions as jest.Mock).mockResolvedValue([
      decision(),
      decision({ id: 'd2', content: 'ship on thursday', status: 'qualified' }),
      decision({ id: 'd3', content: 'old plan', status: 'contradicted' }),
      decision({ id: 'd4', content: 'dropped plan', status: 'withdrawn' }),
    ]);
    const tree = await show('decisions');
    const all = texts(tree);
    expect(all).toContain('We will use the agency quote');
    expect(all).toContain('Ship on thursday');
    expect(all).not.toContain('Old plan');
    expect(all).not.toContain('Dropped plan');
    await act(async () => press(tree, 'Open the meeting this came from: We will use the agency quote'));
    expect(nav.navigate).toHaveBeenCalledWith('Meeting', { meetingId: 'm2', tab: 'transcript', atMs: 9000, play: true });
    await act(async () => tree.unmount());
  });
});

describe('notes to review', () => {
  it('lists meetings with a count and opens that meeting\'s review queue', async () => {
    (db.reviewItems as jest.Mock).mockResolvedValue([
      { meetingId: 'm3', meetingTitle: 'Retro', createdAt: 3, id: 'r1', content: 'book the review' },
      { meetingId: 'm3', meetingTitle: 'Retro', createdAt: 3, id: 'r2', content: 'second' },
      { meetingId: 'm4', meetingTitle: 'Kickoff', createdAt: 2, id: 'r3', content: 'third' },
    ]);
    const tree = await show('review');
    expect(texts(tree).some(x => /2 items to look at/.test(x))).toBe(true);
    expect(texts(tree).some(x => /1 item to look at/.test(x))).toBe(true);
    await act(async () => press(tree, 'Review Retro'));
    expect(nav.navigate).toHaveBeenCalledWith('Review', { meetingId: 'm3' });
    await act(async () => tree.unmount());
  });
});
