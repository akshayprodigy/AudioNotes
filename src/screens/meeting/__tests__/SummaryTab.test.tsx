import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
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
  entitlement: jest.fn(),
}));
jest.mock('../../../billing/subscription', () => ({
  __esModule: true,
  playAvailable: jest.fn().mockResolvedValue(false),
  playPlans: jest.fn().mockResolvedValue([]),
  syncEntitlement: jest.fn().mockResolvedValue(undefined),
  // The real one adds the lapsed flag on top of the native status; these tests drive the native
  // status directly, and SummaryTab.lapsed.test.tsx covers the flag with the real module.
  licenceStatus: () => require('../../../native/NativeLicence').default.status(),
  PLAY_MANAGE_URL: 'https://play.google.com/store/account/subscriptions',
}));

import Licence from '../../../native/NativeLicence';
import { entitlement } from '../../../billing/trial';
import { playAvailable, playPlans, syncEntitlement } from '../../../billing/subscription';
import Llm from '../../../native/NativeLlm';
import ModelManager from '../../../native/NativeModelManager';

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
  transcriptChars: undefined as number | undefined,
  onUpgrade: jest.fn(),
  onEdit: jest.fn(),
  onCopy: jest.fn(),
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

  test('on Pro, a type change over a summary asks first, then saves the type before writing', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const onChangeTemplate = jest.fn().mockResolvedValue(undefined);
    const onWrite = jest.fn();
    const tree = await renderTab({ onChangeTemplate, onWrite });
    const client = (tree.root.findByType(Sheet).props.actions as any[]).find(a => a.label === 'Client call');
    await act(async () => {
      client.onPress();
    });
    expect(alert.mock.calls[0][0]).toBe('Change to Client call?');
    expect(onChangeTemplate).not.toHaveBeenCalled();
    expect(onWrite).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    await act(async () => {
      buttons.find(b => b.text === 'Change')!.onPress!();
    });
    expect(onChangeTemplate).toHaveBeenCalledWith('client');
    expect(onWrite).toHaveBeenCalled();
    expect(onChangeTemplate.mock.invocationCallOrder[0]).toBeLessThan(onWrite.mock.invocationCallOrder[0]);
  });

  test('Cancel changes nothing', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const onChangeTemplate = jest.fn();
    const onWrite = jest.fn();
    const tree = await renderTab({ onChangeTemplate, onWrite });
    const client = (tree.root.findByType(Sheet).props.actions as any[]).find(a => a.label === 'Client call');
    await act(async () => {
      client.onPress();
    });
    const buttons = alert.mock.calls[0][2] as { text: string; style?: string }[];
    expect(buttons.find(b => b.text === 'Cancel')?.style).toBe('cancel');
    expect(onChangeTemplate).not.toHaveBeenCalled();
    expect(onWrite).not.toHaveBeenCalled();
  });

  test('on free, choosing a type relabels only — no rewrite', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
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
    expect(alert).not.toHaveBeenCalled();
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

describe('why there is no summary', () => {
  test('on Free a dictated note is not told it was a meeting with speakers', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    (Llm.available as jest.Mock).mockResolvedValue(true);
    (Llm.capable as jest.Mock).mockResolvedValue(true);
    const note = await renderTab({ minutes: [], template: 'dictation', speakers: [] });
    const meeting = await renderTab({ minutes: [], template: 'standup' });
    const words = (t: renderer.ReactTestRenderer) =>
      t.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);
    expect(words(note).some(t => t.startsWith('Your note is below'))).toBe(true);
    expect(words(note).some(t => t.includes('who said what'))).toBe(false);
    expect(words(meeting).some(t => t.includes('who said what'))).toBe(true);
  });

  test('a phone under the gate hears the memory sentence, not "Settings → Models"', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    (Llm.available as jest.Mock).mockResolvedValue(false);
    (Llm.capable as jest.Mock).mockResolvedValue(false);
    (ModelManager.list as jest.Mock).mockResolvedValueOnce(
      JSON.stringify([
        { id: 'llm-qwen', kind: 'llm', installed: false, sizeBytes: 1, unsupportedReason: 'needs a phone with 4 GB of memory; this one has 2 GB.' },
      ]),
    );
    const tree = await renderTab({ minutes: [] });
    const texts = tree.root
      .findAll(n => typeof n.props.children === 'string')
      .map(n => n.props.children as string);
    expect(texts.some(t => t.includes('this one has 2 GB'))).toBe(true);
    expect(texts.some(t => t.includes('Settings → Models'))).toBe(false);
  });

  test('a capable phone with no model is sent to Settings', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    (Llm.available as jest.Mock).mockResolvedValue(false);
    (Llm.capable as jest.Mock).mockResolvedValue(true);
    const tree = await renderTab({ minutes: [] });
    const texts = tree.root
      .findAll(n => typeof n.props.children === 'string')
      .map(n => n.props.children as string);
    expect(texts.some(t => t.includes('Settings → Models'))).toBe(true);
  });
});

/**
 * The narrator refuses a transcript under MIN_TRANSCRIPT_CHARS (Narrator.kt: 400, about 35 s of
 * speech — below that a 1.5B model invents a meeting). On the Galaxy A07 the tab then kept
 * saying "processed before summaries were written — run it again and one will be" and kept the
 * button, and running it again did nothing, silently. The tab applies the same floor itself.
 */
describe('a transcript too short to write up', () => {
  const texts = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);

  beforeEach(() => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    (Llm.available as jest.Mock).mockResolvedValue(true);
    (Llm.capable as jest.Mock).mockResolvedValue(true);
    (ModelManager.list as jest.Mock).mockResolvedValue('[]');
  });

  test('under the floor: says so, and offers no button', async () => {
    const tree = await renderTab({ minutes: [], transcriptChars: 95 });
    const t = texts(tree);
    expect(t.some(s => s.startsWith('Too little was said to write up'))).toBe(true);
    expect(t.some(s => s.includes('Run it again'))).toBe(false);
    expect(tree.root.findAllByProps({ label: 'Write the summary' }, { deep: false })).toHaveLength(0);
  });

  test('at the floor: the ordinary not-run copy and the button', async () => {
    const tree = await renderTab({ minutes: [], transcriptChars: 400 });
    const t = texts(tree);
    expect(t.some(s => s.includes('Run it again and one will be.'))).toBe(true);
    expect(tree.root.findAllByProps({ label: 'Write the summary' }, { deep: false })).toHaveLength(1);
  });

  test('prose already written is never hidden by the floor', async () => {
    const tree = await renderTab({ transcriptChars: 95 });
    expect(texts(tree)).toContain('A short account of the meeting.');
  });
});

describe('Play\'s trial on the card', () => {
  const annualTrial = {
    basePlanId: 'annual', price: '₹2,499', priceMicros: 2499e6, period: 'P1Y',
    fullPrice: null, trialPeriod: 'P1W', trialCycles: 1, title: null,
  };

  test('offers the trial when Play has one for this account', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false, licence: null });
    (playAvailable as jest.Mock).mockResolvedValue(true);
    (playPlans as jest.Mock).mockResolvedValue([annualTrial]);
    const tree = await renderTab({ minutes: [] });
    await act(async () => {});
    expect(
      tree.root.findAllByProps({ label: 'Try it free for 7 days' }, { deep: false }),
    ).toHaveLength(1);
  });

  test('says Get Pro when Play offers no trial', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false, licence: null });
    (playAvailable as jest.Mock).mockResolvedValue(true);
    (playPlans as jest.Mock).mockResolvedValue([]);
    const tree = await renderTab({ minutes: [] });
    await act(async () => {});
    expect(tree.root.findAllByProps({ label: 'Get Pro' }, { deep: false })).toHaveLength(1);
    const t = tree.root
      .findAll(n => typeof n.props.children === 'string')
      .map(n => n.props.children as string);
    expect(t.some(s => s.includes('Try it free'))).toBe(false);
  });
});

describe('the header row at 384 dp (Step 8)', () => {
  test('the meeting meta is the part of the header that shrinks', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const tree = await renderTab();
    const { Text } = require('react-native');
    const meta = tree.root
      .findAllByType(Text)
      .find(n => typeof n.props.children === 'string' && /min ·/.test(n.props.children as string));
    expect(meta).toBeDefined();
    expect(meta!.props.numberOfLines).toBe(1);
    const flatMeta: Record<string, unknown> = [meta!.props.style]
      .flat(Infinity)
      .reduce((acc: Record<string, unknown>, st) => Object.assign(acc, st), {});
    expect(flatMeta.flexShrink).toBe(1);

    const copyButton = tree.root.findByProps({ accessibilityLabel: 'Copy' });
    let node = copyButton.parent;
    while (
      node &&
      !(node.props.style && [node.props.style].flat(Infinity).some((st: any) => st?.flexShrink === 0))
    ) {
      node = node.parent;
    }
    expect(node).not.toBeNull();
  });
});

describe('a licence that has lapsed on this phone', () => {
  test('offers Check again and Manage, and Check again asks Play again', async () => {
    (Licence.status as jest.Mock).mockResolvedValue({
      state: 'expired', paid: false, expiresAt: 1, lapsedCopy: 'Pro is off on this phone.',
    });
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await renderTab({ minutes: [] });
    expect(tree.root.findAllByProps({ label: 'Manage in Google Play' }, { deep: false })).toHaveLength(1);
    await act(async () => {
      tree.root.findByProps({ label: 'Check again' }).props.onPress();
    });
    expect(syncEntitlement).toHaveBeenCalled();
  });
});

/**
 * F22c (D19): the card said "This meeting was processed before summaries were written" while it was
 * still CHECKING, and again when the check itself threw — claims about the meeting made before
 * anything was known. Only a real 'not-run' may say it; the other two say what is true.
 */
describe('the summary card before and after a check that did not finish', () => {
  const ALL_TEXT = (tree: renderer.ReactTestRenderer) =>
    tree.root
      .findAll(n => typeof n.props.children === 'string')
      .map(n => n.props.children as string)
      .join('|');

  beforeEach(() => {
    jest.clearAllMocks();
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    (Llm.available as jest.Mock).mockResolvedValue(true);
    (Llm.capable as jest.Mock).mockResolvedValue(true);
    (ModelManager.list as jest.Mock).mockResolvedValue('[]');
  });

  test('while the check is running it says Checking… and claims nothing', async () => {
    (Licence.status as jest.Mock).mockReturnValue(new Promise(() => {})); // never settles
    const tree = await renderTab({ minutes: [] });
    const t = ALL_TEXT(tree);
    expect(t).toContain('Checking…');
    expect(t).not.toContain('processed before summaries were written');
    expect(t).not.toContain('Run it again');
  });

  test('a check that throws says it could not check, and Try again re-runs it', async () => {
    (Licence.status as jest.Mock).mockRejectedValue(new Error('native gone'));
    const tree = await renderTab({ minutes: [] });
    let t = ALL_TEXT(tree);
    expect(t).toContain("Couldn't check this phone — try again.");
    expect(t).not.toContain('processed before summaries were written');
    expect(tree.root.findAllByProps({ label: 'Write the summary' }, { deep: false })).toHaveLength(0);

    // It works the second time: the card moves on to its real answer.
    (Licence.status as jest.Mock).mockResolvedValue({
      state: 'active', paid: true, expiresAt: 0, lapsedCopy: '',
    });
    const calls = (Licence.status as jest.Mock).mock.calls.length;
    await act(async () => {
      tree.root.findByProps({ label: 'Try again' }).props.onPress();
    });
    expect((Licence.status as jest.Mock).mock.calls.length).toBeGreaterThan(calls);
    t = ALL_TEXT(tree);
    expect(t).not.toContain("Couldn't check this phone");
    expect(t).toContain('Run it again and one will be.');
  });

  test('the Free copy is unchanged', async () => {
    (Licence.status as jest.Mock).mockResolvedValue({
      state: 'none', paid: false, expiresAt: 0, lapsedCopy: '',
    });
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const tree = await renderTab({ minutes: [] });
    expect(ALL_TEXT(tree)).toContain('Pro writes the meeting up in plain English on this phone');
  });
});

describe('a summary written before the transcript was corrected (F15)', () => {
  const texts = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);

  test('says so, above the Write it again that fixes it', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const tree = await renderTab({ stale: true } as any);
    expect(texts(tree).some(t => t.includes('You corrected the transcript after this summary was written'))).toBe(true);
    expect(tree.root.findAll(n => n.props.label === 'Write it again').length).toBeGreaterThan(0);
  });

  test('says nothing when the summary is current', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const tree = await renderTab({ stale: false } as any);
    expect(texts(tree).some(t => t.includes('You corrected the transcript'))).toBe(false);
  });

  test('says nothing when there is no written summary to be stale', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const tree = await renderTab({ stale: true, minutes: [] } as any);
    expect(texts(tree).some(t => t.includes('You corrected the transcript'))).toBe(false);
  });
});
