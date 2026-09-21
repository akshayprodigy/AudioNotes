import React from 'react';
import renderer, { act } from 'react-test-renderer';
import SummaryTab from '../SummaryTab';
import { Sheet } from '../../../components/ui';

/**
 * The meeting-type chip and its sheet (Phase 2, sub-project 6a). First standalone test for a
 * `meeting/*Tab.tsx` file in this repo — every other tab is exercised only by rendering the whole
 * MeetingScreen (see MeetingScreen.test.tsx's "choosing a meeting type" for the wiring these
 * mocks stand in for). Isolated here because the behaviour under test — SummaryTab's OWN
 * entitlement check deciding whether to also call onWrite — lives entirely inside this
 * component's effect and needs paid/free to be set directly, not threaded through a licence
 * fixture three files away.
 */
jest.mock('../../../native/NativeLicence', () => ({
  __esModule: true,
  default: { status: jest.fn() },
}));
jest.mock('../../../native/NativeLlm', () => ({
  __esModule: true,
  default: { available: jest.fn(), capable: jest.fn() },
}));
jest.mock('../../../billing/trial', () => ({
  __esModule: true,
  TRIAL_DAYS: 7,
  entitlement: jest.fn(),
}));

import Licence from '../../../native/NativeLicence';
import { entitlement } from '../../../billing/trial';

const minute = {
  id: 'min-1',
  meetingId: 'm1',
  kind: 'summary',
  content: 'A short account of the meeting.',
  source: 'llm',
};

const baseProps = {
  items: [] as any[],
  minutes: [minute] as any[],
  speakers: [] as any[],
  speechMs: 60_000,
  highlights: [] as any[],
  onOpenProvenance: jest.fn(),
  canPlay: false,
  onRemoveMark: jest.fn(),
  onWrite: jest.fn(),
  onOpenTab: jest.fn(),
  writing: false,
  template: 'standup' as string | null,
  onChangeTemplate: jest.fn(),
   threads: [] as { tag: string; open: number; decisions: number }[],
   onOpenThread: jest.fn(),
   voiceSuggestions: [] as string[],
   onConfirmVoices: jest.fn(),
};

async function renderTab(props: Partial<typeof baseProps> = {}) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<SummaryTab {...baseProps} {...props} />);
  });
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  (Licence.status as jest.Mock).mockResolvedValue({
    state: 'active',
    lapsedCopy: 'Your subscription has ended.',
  });
});

describe('the meeting-type chip', () => {
  test("shows the meeting's label", async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const tree = await renderTab({ template: 'standup' });
    expect(
      tree.root.findAllByProps({ accessibilityLabel: 'Meeting type: Stand-up' }, { deep: false }),
    ).toHaveLength(1);
  });

  test('a null template reads as General', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const tree = await renderTab({ template: null });
    expect(
      tree.root.findAllByProps({ accessibilityLabel: 'Meeting type: General' }, { deep: false }),
    ).toHaveLength(1);
  });

  test('a dictated note reads Dictation, says one voice, and the chip is not a choice', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const tree = await renderTab({ template: 'dictation', speakers: [] });
    const chip = tree.root.findAllByProps(
      { accessibilityLabel: 'Meeting type: Dictation' },
      { deep: false },
    )[0];
    expect(chip).toBeDefined();
    expect(chip.props.disabled).toBe(true);
    const texts = tree.root
      .findAll(n => typeof n.props.children === 'string')
      .map(n => n.props.children as string);
    expect(texts.some(t => t.includes('one voice'))).toBe(true);
    expect(texts.some(t => t.includes('speakers'))).toBe(false);
  });

  test('tapping it opens a sheet of all seven types, labels and hints included', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const tree = await renderTab();
    const chip = tree.root.findAllByProps(
      { accessibilityLabel: 'Meeting type: Stand-up' },
      { deep: false },
    )[0];
    await act(async () => {
      chip.props.onPress();
    });
    const sheet = tree.root.findByType(Sheet);
    expect(sheet.props.visible).toBe(true);
    const actions = sheet.props.actions as { label: string; hint?: string }[];
    expect(actions.map(a => a.label)).toEqual([
      'General', 'Stand-up', 'One-to-one', 'Client call', 'Interview', 'Lecture', 'Site walk',
    ]);
    expect(actions.every(a => Boolean(a.hint))).toBe(true);
  });

  test('choosing a type calls onChangeTemplate with its id', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const onChangeTemplate = jest.fn();
    const tree = await renderTab({ onChangeTemplate });
    const sheet = tree.root.findByType(Sheet);
    const client = (sheet.props.actions as any[]).find(a => a.label === 'Client call');
    await act(async () => {
      client.onPress();
    });
    expect(onChangeTemplate).toHaveBeenCalledWith('client');
  });

  test('on Pro, choosing a type also triggers "Write it again"', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const onWrite = jest.fn();
    const tree = await renderTab({ onWrite });
    const sheet = tree.root.findByType(Sheet);
    const client = (sheet.props.actions as any[]).find(a => a.label === 'Client call');
    await act(async () => {
      client.onPress();
    });
    expect(onWrite).toHaveBeenCalled();
  });

  test('on free, choosing a type relabels only — no rewrite', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const onChangeTemplate = jest.fn();
    const onWrite = jest.fn();
    const tree = await renderTab({ onChangeTemplate, onWrite });
    const sheet = tree.root.findByType(Sheet);
    const client = (sheet.props.actions as any[]).find(a => a.label === 'Client call');
    await act(async () => {
      client.onPress();
    });
    expect(onChangeTemplate).toHaveBeenCalledWith('client');
    expect(onWrite).not.toHaveBeenCalled();
  });
});

describe('the thread line (Phase 3)', () => {
  const threads = [{ tag: 'weekly', open: 2, decisions: 3 }];

  test('on Pro, the line renders and tapping it calls onOpenThread', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const onOpenThread = jest.fn();
    const tree = await renderTab({ threads, onOpenThread });
    const row = tree.root.findByProps({ accessibilityLabel: 'Open thread weekly' });
    expect(row.findByType(require('../../../components/ui').Txt).props.children).toBe(
      'weekly: 2 open · 3 decisions',
    );
    await act(async () => {
      row.props.onPress();
    });
    expect(onOpenThread).toHaveBeenCalledWith('weekly');
  });

  test('on free, no thread line renders', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const tree = await renderTab({ threads });
    expect(
      tree.root.findAllByProps({ accessibilityLabel: 'Open thread weekly' }, { deep: false }),
    ).toHaveLength(0);
  });

  test('an empty threads list renders nothing', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const tree = await renderTab({ threads: [] });
    const { Pressable } = require('react-native');
    const threadRows = tree.root
      .findAllByType(Pressable)
      .filter(n => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Open thread'));
    expect(threadRows).toHaveLength(0);
  });

  test('four entries render three', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const four = ['a', 'b', 'c', 'd'].map(tag => ({ tag, open: 1, decisions: 1 }));
    const tree = await renderTab({ threads: four });
    const rows = ['a', 'b', 'c', 'd']
      .map(tag => tree.root.findAllByProps({ accessibilityLabel: `Open thread ${tag}` }, { deep: false }))
      .filter(matches => matches.length > 0);
    expect(rows).toHaveLength(3);
  });

  test('the second row calls onOpenThread with its OWN tag, not the first', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const onOpenThread = jest.fn();
    const two = [
      { tag: 'weekly', open: 1, decisions: 1 },
      { tag: 'client-acme', open: 2, decisions: 0 },
    ];
    const tree = await renderTab({ threads: two, onOpenThread });
    const row = tree.root.findByProps({ accessibilityLabel: 'Open thread client-acme' });
    await act(async () => {
      row.props.onPress();
    });
    expect(onOpenThread).toHaveBeenCalledWith('client-acme');
  });
});

describe('the voice banner', () => {
  test('paid + one name shows the banner and pressing confirms', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const onConfirmVoices = jest.fn();
    const tree = await renderTab({ voiceSuggestions: ['Priya'], onConfirmVoices });
    const banner = tree.root.findByProps({ accessibilityLabel: 'Confirm voices' });
    expect(banner.findByProps({ variant: 'bodyBlack' }).props.children).toBe(
      'Sounds like Priya — confirm?',
    );
    await act(async () => {
      banner.props.onPress();
    });
    expect(onConfirmVoices).toHaveBeenCalled();
  });

  test('paid + three names collapses to "and 1 more"', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const tree = await renderTab({
      voiceSuggestions: ['Priya', 'Ravi', 'Sam'],
      onConfirmVoices: jest.fn(),
    });
    const banner = tree.root.findByProps({ accessibilityLabel: 'Confirm voices' });
    expect(banner.findByProps({ variant: 'bodyBlack' }).props.children).toBe(
      'Sounds like Priya, Ravi and 1 more — confirm?',
    );
  });

  test('on free, no banner renders', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const tree = await renderTab({ voiceSuggestions: ['Priya'], onConfirmVoices: jest.fn() });
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Confirm voices' })).toHaveLength(0);
  });

  test('paid + an empty list renders nothing', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const tree = await renderTab({ voiceSuggestions: [], onConfirmVoices: jest.fn() });
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Confirm voices' })).toHaveLength(0);
  });
});
