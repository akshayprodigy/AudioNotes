import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import LibraryScreen from '../LibraryScreen';
import { db } from '../../db/queries';
import { useLibraryStore } from '../../state/libraryStore';
import { entitlement } from '../../billing/trial';
import { dayStart } from '../followUpData';
import { lightColors } from '../../theme';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../billing/trial', () => ({
  ...jest.requireActual('../../billing/trial'),
  entitlement: jest.fn(),
}));

/** The capture streak (Workstream F): a quiet line below the follow-up card, never urgent. */
const nav = { navigate: jest.fn(), addListener: jest.fn(() => jest.fn()) } as never;
const route = { key: 'library', name: 'Library', params: undefined } as never;

const TODAY = dayStart(Date.now());
const DAY = 86_400_000;

const action = (over: Record<string, unknown> = {}) => ({
  meetingId: 'm1', meetingTitle: 'Standup', createdAt: 1, id: 'a1', content: 'Send the report — Priya (due Friday)',
  ownerJson: null, source: 'rule', anchorStartMs: 4000, dateNorm: TODAY - DAY, ...over,
});

const meeting = (id: string, createdAt: number) => ({
  id, title: `Meeting ${id}`, createdAt, durationMs: 600_000, language: 'en', status: 'done',
  tierUsed: 'free', audioRetained: 1, summaryLine: null, mode: null,
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

describe('the capture streak is quiet and below the follow-up card', () => {
  const recent = () => [meeting('a', Date.now()), meeting('b', Date.now() - DAY), meeting('c', Date.now() - 2 * DAY)];

  it('comes after the follow-up card, not before it', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue(recent());
    (db.allActions as jest.Mock).mockResolvedValue([action()]);
    const tree = await show();
    const all = texts(tree);
    const follow = all.indexOf('FOLLOW-UP');
    const streak = all.findIndex(x => /days in a row/.test(x));
    expect(follow).toBeGreaterThanOrEqual(0);
    expect(streak).toBeGreaterThan(follow);
    // ...and still above the meeting list, so it is a line under the card rather than a footer
    // buried under a long library.
    expect(streak).toBeLessThan(all.indexOf('Meeting a'));
    await act(async () => tree.unmount());
  });

  it('still shows for a Free user, who has no follow-up card', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    (db.listMeetings as jest.Mock).mockResolvedValue(recent());
    const tree = await show();
    expect(texts(tree).some(x => /3 days in a row/.test(x))).toBe(true);
    await act(async () => tree.unmount());
  });

  it('has no urgency or loss wording anywhere on the screen', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue(recent());
    (db.allActions as jest.Mock).mockResolvedValue([action()]);
    const tree = await show();
    const joined = texts(tree).join(' | ');
    for (const bad of [/keep (up )?your/i, /don'?t (break|lose)/i, /\blose\b/i, /\blost\b/i, /\bat risk\b/i, /\bbreak\b/i, /\bstreak\b/i, /\bmiss(ed)?\b/i]) {
      expect(joined).not.toMatch(bad);
    }
    await act(async () => tree.unmount());
  });

  it('is never drawn in an alert colour', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue(recent());
    const tree = await show();
    const line = tree.root.findAll(n => n.type === Text && /days in a row/.test([n.props.children].flat().join('')))[0];
    const color = StyleSheet.flatten(line.props.style).color;
    expect(color).toBe(lightColors.inkFaint);
    expect([lightColors.danger, lightColors.warning, lightColors.dangerSoft]).not.toContain(color);
    await act(async () => tree.unmount());
  });

  it('keeps its data: no streak under two days, three days reads three', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([meeting('a', Date.now())]);
    const one = await show();
    expect(texts(one).some(x => /days in a row/.test(x))).toBe(false);
    await act(async () => one.unmount());

    (db.listMeetings as jest.Mock).mockResolvedValue(recent());
    const three = await show();
    expect(texts(three)).toContain('Recorded 3 days in a row');
    await act(async () => three.unmount());
  });
});
