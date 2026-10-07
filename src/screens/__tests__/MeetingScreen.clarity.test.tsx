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
import AskEntry from '../meeting/AskEntry';
import { IconButton, Sheet } from '../../components/ui';

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

describe('a folded section says what is in it', () => {
  it('shows the first finished next step beside DONE while it is folded', async () => {
    (db.items as jest.Mock).mockResolvedValue(FIXTURE);
    (db.minutes as jest.Mock).mockResolvedValue([]);
    (db.doneItems as jest.Mock).mockResolvedValue(new Set(['i4']));
    const tree = await open({ tab: 'actions' });
    expect(texts(tree)).toContain('DONE · 1');
    expect(texts(tree)).toContain('I will share the checklist');
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

// ---------------------------------------------------------------------------------------------
// Item 3 — Ask is discoverable and labelled
// ---------------------------------------------------------------------------------------------

describe('the "Ask this meeting" entry', () => {
  const trial = require('../../billing/trial');
  const ModelManager = require('../../native/NativeModelManager').default;
  const { Alert } = require('react-native');
  const WEAK = 'The writer needs 4 GB of memory; this phone has 2 GB.';

  const setup = (paid: boolean, models: unknown[] = []) => {
    jest.spyOn(trial, 'entitlement').mockResolvedValue({ paid, licence: null });
    (ModelManager.list as jest.Mock).mockResolvedValue(JSON.stringify(models));
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  };
  afterEach(() => jest.restoreAllMocks());

  /** The labelled entry on a tab, not the header icon or the overflow row. */
  const labelled = (t: renderer.ReactTestRenderer) =>
    t.root.findAll(n => String(n.type) === 'Text' && [n.props.children].flat().join('') === 'Ask this meeting');
  const tap = async (t: renderer.ReactTestRenderer) => {
    await act(async () => {
      t.root.findByType(AskEntry).props.onPress();
    });
  };

  it('is visible, in words, on the Minutes and Summary tabs', async () => {
    setup(true);
    for (const tab of ['mom', 'summary']) {
      const tree = await open({ tab });
      expect(labelled(tree).length).toBeGreaterThan(0);
      await act(async () => tree.unmount());
    }
  });

  it('takes Pro on a capable phone straight to Ask', async () => {
    setup(true);
    const tree = await open({ tab: 'mom' });
    await tap(tree);
    expect(nav.navigate).toHaveBeenCalledWith('Ask', { meetingId: 'm1' });
    expect(Alert.alert).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('tells a Free person what Ask is, with one Upgrade that opens the paywall', async () => {
    setup(false);
    const tree = await open({ tab: 'mom' });
    await tap(tree);
    expect(nav.navigate).not.toHaveBeenCalledWith('Ask', expect.anything());
    const [title, body, buttons] = (Alert.alert as jest.Mock).mock.calls[0];
    expect(title).toBe('Ask this meeting');
    expect(body).toMatch(/transcript/);
    expect(buttons.map((b: { text: string }) => b.text)).toEqual(['Not now', 'Upgrade to Pro']);
    await act(async () => buttons[1].onPress());
    expect(nav.navigate).toHaveBeenCalledWith('Paywall', { meetingId: 'm1' });
    await act(async () => tree.unmount());
  });

  it('on a phone that cannot run the writer names what Pro offers and does not promise Ask', async () => {
    setup(false, [{ id: 'qwen', kind: 'llm', sizeBytes: 1, installed: false, unsupportedReason: WEAK }]);
    const tree = await open({ tab: 'mom' });
    await tap(tree);
    const [, body] = (Alert.alert as jest.Mock).mock.calls[0];
    expect(body).toContain(WEAK);
    expect(body).toContain('Search by meaning');
    expect(body).toMatch(/cannot answer/);
    expect(body).not.toMatch(/is part of Pro/);
    await act(async () => tree.unmount());
  });

  it('for Pro on such a phone explains and sells nothing', async () => {
    setup(true, [{ id: 'qwen', kind: 'llm', sizeBytes: 1, installed: false, unsupportedReason: WEAK }]);
    const tree = await open({ tab: 'mom' });
    await tap(tree);
    const [, body, buttons] = (Alert.alert as jest.Mock).mock.calls[0];
    expect(body).toContain(WEAK);
    expect(buttons.map((b: { text: string }) => b.text)).toEqual(['OK']);
    await act(async () => tree.unmount());
  });

  it('is the same entry from the header icon and the overflow sheet', async () => {
    setup(false);
    const tree = await open({ tab: 'mom' });
    const header = tree.root.findAllByType(IconButton).find(b => b.props.label === 'Ask this meeting')!;
    await act(async () => header.props.onPress());
    expect(Alert.alert).toHaveBeenCalledTimes(1);
    const row = tree.root
      .findAllByType(Sheet)
      .flatMap(sh => sh.props.actions as { label: string; onPress: () => void }[])
      .find(a => a.label === 'Ask this meeting')!;
    await act(async () => row.onPress());
    expect(Alert.alert).toHaveBeenCalledTimes(2);
    await act(async () => tree.unmount());
  });

  it('marks the entry Pro for a Free person, in words, and not for Pro', async () => {
    setup(false);
    let tree = await open({ tab: 'mom' });
    expect(texts(tree)).toContain('Pro');
    await act(async () => tree.unmount());
    setup(true);
    tree = await open({ tab: 'mom' });
    expect(texts(tree)).not.toContain('Pro');
    await act(async () => tree.unmount());
  });
});

// ---------------------------------------------------------------------------------------------
// Item 5 — visible editing affordances
// ---------------------------------------------------------------------------------------------

describe('visible Edit controls', () => {
  const { StyleSheet } = require('react-native');
  const { TextPrompt } = require('../../components/ui');
  const editBtn = (t: renderer.ReactTestRenderer, label: string) =>
    t.root.findAll(
      n => typeof n.type === 'string' && n.props.accessibilityLabel === label && n.props.accessibilityRole === 'button',
    );
  const withHandler = (t: renderer.ReactTestRenderer, label: string) =>
    t.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
  const prompt = (t: renderer.ReactTestRenderer) => t.root.findAllByType(TextPrompt).find(p => p.props.visible);

  beforeEach(() => {
    (db.items as jest.Mock).mockResolvedValue(FIXTURE);
    (db.minutes as jest.Mock).mockResolvedValue([]);
  });

  it('gives every action and decision on the Minutes tab a labelled Edit control of 44 dp', async () => {
    const tree = await open({ tab: 'mom' });
    expect(editBtn(tree, 'Edit this action')).toHaveLength(3);
    expect(editBtn(tree, 'Edit this decision')).toHaveLength(1);
    expect(editBtn(tree, 'Edit this question')).toHaveLength(1);
    const style = StyleSheet.flatten(editBtn(tree, 'Edit this action')[0].props.style);
    expect(style.width).toBeGreaterThanOrEqual(44);
    expect(style.height).toBeGreaterThanOrEqual(44);
    await act(async () => tree.unmount());
  });

  it('opens the editor the long press opens, on the same words and the same item', async () => {
    const tree = await open({ tab: 'mom' });
    await act(async () => withHandler(tree, 'Edit this action')[0].props.onPress());
    const viaButton = prompt(tree)!;
    expect(viaButton.props.initial).toBe('I will send the signed quote — Priya (due Wednesday)');
    expect(viaButton.props.title).toBe('Correct this line');
    await act(async () => viaButton.props.onCancel());
    // The long press on the same row.
    const row = tree.root.findAll(
      n => n.props.accessibilityHint === 'Long press to correct this line' && typeof n.props.onLongPress === 'function',
    )[1];
    await act(async () => row.props.onLongPress());
    const viaLongPress = prompt(tree)!;
    expect(viaLongPress.props.initial).toBe(viaButton.props.initial);
    expect(viaLongPress.props.title).toBe(viaButton.props.title);
    await act(async () => tree.unmount());
  });

  it('saves an edit made through the control against the item', async () => {
    const tree = await open({ tab: 'mom' });
    await act(async () => withHandler(tree, 'Edit this action')[0].props.onPress());
    await act(async () => prompt(tree)!.props.onSubmit('I will send the quote by Thursday — Priya', ''));
    expect(db.putEdit).toHaveBeenCalledWith('m1', 'item', 'i2', 'I will send the quote by Thursday — Priya');
    await act(async () => tree.unmount());
  });

  it('is on every Actions-tab row, and ticking still works beside it', async () => {
    (db.setItemDone as jest.Mock).mockResolvedValue(undefined);
    const tree = await open({ tab: 'actions' });
    expect(editBtn(tree, 'Edit this action')).toHaveLength(3);
    expect(editBtn(tree, 'Edit this decision')).toHaveLength(1);
    await act(async () => withHandler(tree, 'Edit this action')[0].props.onPress());
    expect(prompt(tree)!.props.initial).toContain('signed quote');
    expect(db.setItemDone).not.toHaveBeenCalled();
    await act(async () => prompt(tree)!.props.onCancel());
    const box = tree.root.findAll(n => n.props.accessibilityRole === 'checkbox' && typeof n.props.onPress === 'function')[0];
    await act(async () => box.props.onPress());
    expect(db.setItemDone).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());
  });

  it('puts an Edit control on a transcript line that opens the same correction as the long-press sheet', async () => {
    (db.utterances as jest.Mock).mockResolvedValue([
      { id: 'u1', meetingId: 'm1', startMs: 0, endMs: 2000, speakerId: 's1', text: 'Hello there.' },
    ]);
    (db.speakers as jest.Mock).mockResolvedValue([{ id: 's1', meetingId: 'm1', clusterLabel: 'S0', displayName: 'Priya' }]);
    const tree = await open({ tab: 'transcript' });
    await act(async () => withHandler(tree, 'Edit this line')[0].props.onPress());
    const p = prompt(tree)!;
    expect(p.props.initial).toBe('Hello there.');
    expect(p.props.title).toBe('Correct this line');
    await act(async () => p.props.onSubmit('Hello, Priya.', ''));
    expect(db.putEdit).toHaveBeenCalledWith('m1', 'utterance', 'u1', 'Hello, Priya.');
    await act(async () => tree.unmount());
  });

  it('rename speakers opens the Speakers screen', async () => {
    (db.utterances as jest.Mock).mockResolvedValue([
      { id: 'u1', meetingId: 'm1', startMs: 0, endMs: 2000, speakerId: 's1', text: 'Hello there.' },
    ]);
    (db.speakers as jest.Mock).mockResolvedValue([{ id: 's1', meetingId: 'm1', clusterLabel: 'S0', displayName: 'Priya' }]);
    const tree = await open({ tab: 'transcript' });
    await act(async () => withHandler(tree, 'Rename speakers')[0].props.onPress());
    expect(nav.navigate).toHaveBeenCalledWith('Speakers', { meetingId: 'm1' });
    await act(async () => tree.unmount());
  });
});

// ---------------------------------------------------------------------------------------------
// Item 7 — accessibility: roles, labels, states and reading order
// ---------------------------------------------------------------------------------------------

describe('the tab bar for a screen reader', () => {
  const { StyleSheet } = require('react-native');
  const tabNodes = (t: renderer.ReactTestRenderer) =>
    t.root.findAll(n => typeof n.type === 'string' && n.props.accessibilityRole === 'tab');

  it('says where each tab is and which one is selected', async () => {
    const tree = await open({ tab: 'mom' });
    expect(tabNodes(tree).map(n => n.props.accessibilityLabel)).toEqual([
      'Summary, tab 1 of 4',
      'Minutes, tab 2 of 4',
      'Transcript, tab 3 of 4',
      'Actions, tab 4 of 4',
    ]);
    expect(tabNodes(tree).map(n => n.props.accessibilityState.selected)).toEqual([false, true, false, false]);
    expect(tree.root.findAll(n => typeof n.type === 'string' && n.props.accessibilityRole === 'tablist')).toHaveLength(1);
    await act(async () => tree.unmount());
  });

  it('moves the selection with the tab', async () => {
    const tree = await open({ tab: 'mom' });
    const press = tree.root.findAll(
      n => String(n.props.accessibilityLabel).startsWith('Actions, tab') && typeof n.props.onPress === 'function',
    )[0];
    await act(async () => press.props.onPress());
    expect(tabNodes(tree).map(n => n.props.accessibilityState.selected)).toEqual([false, false, false, true]);
    await act(async () => tree.unmount());
  });

  it('is at least 44 dp tall and never gives a label a fixed height', async () => {
    const tree = await open({ tab: 'mom' });
    for (const n of tabNodes(tree)) {
      const st = StyleSheet.flatten(n.props.style);
      expect(st.minHeight).toBeGreaterThanOrEqual(44);
      expect(st.height).toBeUndefined();
    }
    await act(async () => tree.unmount());
  });
});

describe('headings, rows and reading order', () => {
  beforeEach(() => {
    (db.items as jest.Mock).mockResolvedValue(FIXTURE);
    (db.minutes as jest.Mock).mockResolvedValue([]);
  });

  it('reads title, then takeaway, then Decisions, then Next steps, top to bottom', async () => {
    const tree = await open({ tab: 'mom' });
    const order = texts(tree);
    const at = (s: string) => order.findIndex(x => x.startsWith(s));
    expect(at('Standup')).toBeGreaterThanOrEqual(0);
    expect(at('Standup')).toBeLessThan(at('Decided:'));
    expect(at('Decided:')).toBeLessThan(at('Decisions · 1'));
    expect(at('Decisions · 1')).toBeLessThan(at('Next steps · 3'));
    expect(at('Next steps · 3')).toBeLessThan(at('Questions · 1'));
    await act(async () => tree.unmount());
  });

  it('marks the Summary tab\'s own heading as a heading', async () => {
    const tree = await open({ tab: 'summary' });
    expect(headers(tree)).toContain('SUMMARY');
    await act(async () => tree.unmount());
  });

  it('gives each next step a spoken label with owner, due date and state, and a checkbox state', async () => {
    (db.doneItems as jest.Mock).mockResolvedValue(new Set(['i4']));
    const tree = await open({ tab: 'actions' });
    const boxes = tree.root.findAll(n => typeof n.type === 'string' && n.props.accessibilityRole === 'checkbox');
    const labels = boxes.map(b => [b.props.accessibilityLabel, b.props.accessibilityState.checked]);
    expect(labels).toContainEqual(['I will send the signed quote. Owner Priya. Due Wednesday. Not done', false]);
    expect(labels).toContainEqual(['The review still needs to be booked. No owner yet. Not done', false]);
    await act(async () => tree.unmount());
  });

  it('says Done in the label of a ticked one, and in words on the Minutes tab too', async () => {
    (db.doneItems as jest.Mock).mockResolvedValue(new Set(['i4']));
    const mom = await open({ tab: 'mom' });
    const spoken = mom.root
      .findAll(n => typeof n.type === 'string' && String(n.props.accessibilityLabel ?? '').startsWith('I will share the checklist'))
      .map(n => n.props.accessibilityLabel);
    expect(spoken).toContain('I will share the checklist. Owner Sam. Done');
    expect(texts(mom)).toContain('Done');
    await act(async () => mom.unmount());
  });

  it('does not depend on colour: a ticked action on the Actions tab says Done in words and is a checked checkbox', async () => {
    (db.doneItems as jest.Mock).mockResolvedValue(new Set(['i4']));
    const tree = await open({ tab: 'actions' });
    // Done is folded away by default; open it.
    const fold = tree.root.findAll(n => n.props.accessibilityState?.expanded === false && typeof n.props.onPress === 'function')[0];
    await act(async () => fold.props.onPress());
    expect(texts(tree)).toContain('Done');
    const ticked = tree.root.findAll(
      n => typeof n.type === 'string' && n.props.accessibilityRole === 'checkbox' && n.props.accessibilityState.checked === true,
    );
    expect(ticked.map(b => b.props.accessibilityLabel)).toEqual(['I will share the checklist. Owner Sam. Done']);
    await act(async () => tree.unmount());
  });

  it('keeps the Ask entry a labelled button, in reading order after the takeaway', async () => {
    const tree = await open({ tab: 'mom' });
    const buttons = tree.root.findAll(n => typeof n.type === 'string' && n.props.accessibilityLabel === 'Ask this meeting' && n.props.accessibilityRole === 'button');
    expect(buttons.length).toBeGreaterThan(0);
    const order = texts(tree);
    expect(order.findIndex(x => x.startsWith('Decided:'))).toBeLessThan(order.indexOf('Ask this meeting', order.findIndex(x => x.startsWith('Decided:'))));
    await act(async () => tree.unmount());
  });
});
