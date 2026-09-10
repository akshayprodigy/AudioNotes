import React from 'react';
import { FlatList } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import MeetingScreen from '../MeetingScreen';
import TranscriptTab from '../meeting/TranscriptTab';
import { ProvenanceButton, provenanceLabel } from '../meeting/ItemProvenance';
import { itemKey, toItemRows } from '../meeting/shared';
import { loadActions } from '../actionsData';
import { db } from '../../db/queries';
import type { Item, Minute, Utterance } from '../../pipeline/types';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const ACTION = 'Ana to update the roadmap by Thursday — Ana (due Thursday)';

const item = (over: Partial<Item> = {}): Item => ({
  id: 'it-action',
  meetingId: 'm1',
  kind: 'action',
  text: ACTION,
  review: 'suggested',
  genVersion: 'rules@1',
  anchorStartMs: 65_000,
  anchorEndMs: 69_000,
  sources: [{ startMs: 65_000, endMs: 69_000, charStart: 0, charEnd: 40, utteranceId: 'u2' }],
  ...over,
});

const minute = (over: Partial<Minute> = {}): Minute => ({
  id: 'min-action',
  meetingId: 'm1',
  kind: 'action',
  content: ACTION,
  source: 'rule',
  ...over,
});

const utterance = (over: Partial<Utterance> = {}): Utterance =>
  ({
    id: 'u1',
    meetingId: 'm1',
    startMs: 0,
    endMs: 4_000,
    speakerId: 's1',
    text: 'Alright team, let us kick off the design review.',
    ...over,
  } as Utterance);

// ------------------------------------------------------------------------------------------
// The label and the button
// ------------------------------------------------------------------------------------------

describe('provenanceLabel', () => {
  it('reads as a timestamp a person can find in the recording', () => {
    expect(provenanceLabel(0)).toBe('0:00');
    expect(provenanceLabel(65_000)).toBe('1:05');
    expect(provenanceLabel(3_725_000)).toBe('1:02:05');
  });

  it('does not run backwards on a nonsense anchor', () => {
    expect(provenanceLabel(-1)).toBe('0:00');
  });
});

describe('ProvenanceButton', () => {
  /**
   * `create` inside `act`, unlike the plan's listing. React 19 does not commit effects for a
   * render started outside one, and a renderer created that way answers `.root` with "unmounted".
   * It is the same shape every other screen test here uses.
   */
  const draw = (el: React.ReactElement) => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(el);
    });
    return tree;
  };

  it('opens the transcript at the anchor and plays from there', () => {
    const onOpen = jest.fn();
    const tree = draw(<ProvenanceButton anchorStartMs={65_000} onOpen={onOpen} canPlay={true} />);
    act(() => {
      tree.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });
    expect(onOpen).toHaveBeenCalledWith(65_000);
    expect(tree.root.findByProps({ accessibilityRole: 'button' }).props.accessibilityLabel).toBe(
      'Play from 1:05',
    );
  });

  /**
   * `meetings.audio_retained` goes to 0 the moment a recording is swept or discarded, and such a
   * meeting still has its transcript and its item anchors — the rule pass runs over stored text
   * and needs no audio at all. The button must lose the playback half and keep the link.
   */
  it('still offers the transcript when the audio is gone', () => {
    const onOpen = jest.fn();
    const tree = draw(<ProvenanceButton anchorStartMs={5_000} onOpen={onOpen} canPlay={false} />);
    act(() => {
      tree.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });
    expect(onOpen).toHaveBeenCalledWith(5_000);
    expect(tree.root.findByProps({ accessibilityRole: 'button' }).props.accessibilityLabel).toBe(
      'Show this in the transcript at 0:05',
    );
  });
});

// ------------------------------------------------------------------------------------------
// What the tabs are given to render
// ------------------------------------------------------------------------------------------

describe('toItemRows', () => {
  it('gives an item its anchor and its id, and drops the minute that says the same thing', () => {
    const rows = toItemRows([item()], [minute(), minute({ id: 'min-sum', kind: 'summary' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: 'it-action', anchorStartMs: 65_000, mine: false });
  });

  /**
   * The transitional half, and the reason it exists. `db.addUserMinute` writes a `minutes` row
   * with source='user' and no item until Task 12 moves it, so a tab rendering items alone would
   * make a hand-typed action vanish from the screen it was typed on.
   */
  it('keeps a hand-typed row, with no anchor and no item id', () => {
    const typed = minute({ id: 'min-user', content: 'Call the vendor back', source: 'user' });
    const rows = toItemRows([item()], [minute(), typed]);
    expect(rows.map(r => r.text)).toEqual([ACTION, 'Call the vendor back']);
    expect(rows[1]).toMatchObject({ itemId: null, minuteId: 'min-user', anchorStartMs: null });
    expect(rows[1].mine).toBe(true);
  });

  /**
   * `ensureItems` needs the native core and MeetingScreen swallows its failure on purpose, so a
   * pre-items meeting can be on screen with no items at all. It has always shown its minutes
   * there; rendering items alone would draw an empty tab under a Summary tab still counting them.
   */
  it('falls back to the minutes when a meeting has no items at all', () => {
    const rows = toItemRows([], [minute(), minute({ id: 'min-sum', kind: 'summary' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: null, minuteId: 'min-action', anchorStartMs: null });
    expect(rows[0].mine).toBe(false);
  });

  it('never turns a summary or a narrative into an item row', () => {
    const rows = toItemRows([], [
      minute({ id: 'min-sum', kind: 'summary' }),
      minute({ id: 'min-nar', kind: 'narrative', source: 'llm' }),
    ]);
    expect(rows).toHaveLength(0);
  });
});

/**
 * THE PROPERTY THAT LETS THIS CONVERSION KEEP PEOPLE'S CORRECTIONS.
 *
 * Corrections are rows in `edits` keyed `target_kind='minute'`, `target_key=itemKey(stored minute
 * content)`, and Task 11 — not this task — is what moves them onto item ids. So after the tabs
 * switch to items, an existing correction resolves only if `itemKey(item.text)` reproduces
 * `itemKey(minute.content)`.
 *
 * It does, because `Minutes.extract` and `Minutes.extractItems` are the same rules over the same
 * turns — the property `AudioDb.backfillItems` already bets every tick in every existing library
 * on. The two strings are not byte-identical in every case: `extractItems` asciifies non-breaking
 * spaces before splitting sentences and `extractMinutes` does not. `itemKey` collapses every
 * whitespace run to one space before hashing, so that difference cannot reach the key, which is
 * what the second case here pins.
 */
describe('the edits key survives the move from minutes to items', () => {
  it('hashes an item to the key its minute already had', () => {
    expect(itemKey(item().text)).toBe(itemKey(minute().content));
    expect(toItemRows([item()], [])[0].editKey).toBe(itemKey(minute().content));
  });

  it('is blind to the one way the two extractors differ', () => {
    // What extractMinutes stores (the non-breaking space survives its sentence split) against what
    // extractItems produces (asciified first). Same item, same key.
    expect(itemKey('Ana to update the roadmap')).toBe(itemKey('Ana to update the roadmap'));
    expect(itemKey('Ana to  update')).toBe(itemKey('Ana to update'));
  });
});

// ------------------------------------------------------------------------------------------
// The screen
// ------------------------------------------------------------------------------------------

const nav = { navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() } as any;

/** The shared `item_done` store both readers are asked about. */
let ticks: Set<string>;

async function render(params: Record<string, unknown> = {}) {
  let tree!: renderer.ReactTestRenderer;
  const route = { key: 'meeting', name: 'Meeting', params: { meetingId: 'm1', ...params } } as any;
  await act(async () => {
    tree = renderer.create(<MeetingScreen navigation={nav} route={route} />);
  });
  return tree;
}

const player = () => (global as any).__TEST_NATIVE_MODULES__.Player;

beforeEach(() => {
  jest.clearAllMocks();
  ticks = new Set();
  player().hasAudio.mockResolvedValue(false);

  (db.ensureItems as jest.Mock).mockResolvedValue(undefined);
  (db.getMeeting as jest.Mock).mockResolvedValue({
    id: 'm1',
    title: 'Standup',
    createdAt: 1,
    durationMs: 600_000,
    status: 'done',
    tierUsed: 'free',
    language: 'en',
    audioPath: null,
    audioRetained: 1,
  });
  (db.minutes as jest.Mock).mockResolvedValue([minute()]);
  (db.items as jest.Mock).mockResolvedValue([item()]);
  (db.utterances as jest.Mock).mockResolvedValue([
    utterance(),
    utterance({ id: 'u2', startMs: 60_000, endMs: 70_000, text: 'I will update the roadmap.' }),
  ]);
  (db.segments as jest.Mock).mockResolvedValue([]);
  (db.speakers as jest.Mock).mockResolvedValue([]);
  (db.edits as jest.Mock).mockResolvedValue([]);
  (db.tagsFor as jest.Mock).mockResolvedValue([]);
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  (db.setSetting as jest.Mock).mockResolvedValue(undefined);

  // One store behind three calls, so a tick written by the tab can be read back by the tab AND by
  // the cross-meeting worklist's own loader rather than merely asserted about.
  const flat = (meetingId: string, itemId: string) => `${meetingId} ${itemId}`;
  (db.setItemDone as jest.Mock).mockImplementation(async (m: string, i: string, on: boolean) => {
    if (on) ticks.add(flat(m, i));
    else ticks.delete(flat(m, i));
  });
  (db.doneItems as jest.Mock).mockImplementation(async (m: string) =>
    new Set([...ticks].filter(k => k.startsWith(`${m} `)).map(k => k.split(' ')[1])),
  );
  (db.doneItemIds as jest.Mock).mockImplementation(async () => new Set(ticks));
  (db.doneActions as jest.Mock).mockResolvedValue(new Set<string>());
  (db.setActionDone as jest.Mock).mockResolvedValue(undefined);
  (db.addUserMinute as jest.Mock).mockResolvedValue('min-user');
});

/**
 * The buttons carrying one accessibility label, one node each.
 *
 * `deep: false` because a Pressable and the View it renders both carry the label, so the default
 * deep search reports three nodes for one button and "how many timestamps are on this screen"
 * silently becomes "how many nodes mention one".
 */
const byLabel = (tree: renderer.ReactTestRenderer, accessibilityLabel: string) =>
  tree.root.findAllByProps({ accessibilityLabel }, { deep: false });

describe('the MOM tab', () => {
  it('shows the moment each item was said', async () => {
    const tree = await render({ tab: 'mom' });
    expect(byLabel(tree, 'Show this in the transcript at 1:05').length).toBeGreaterThan(0);
    await act(async () => tree.unmount());
  });

  /**
   * The conversion's real risk. An existing correction is keyed on a hash of the MINUTE text; the
   * row it is drawn against is now an ITEM. It renders because the two hash the same — see the
   * key test above — and this is that property exercised through the screen rather than in the
   * abstract, because a lost correction is silent.
   */
  it('still shows a correction written against the minute it replaced', async () => {
    (db.edits as jest.Mock).mockResolvedValue([
      {
        meetingId: 'm1',
        targetKind: 'minute',
        targetKey: itemKey(minute().content),
        content: 'Ana to update the roadmap by FRIDAY — Ana',
        editedAt: 2,
      },
    ]);
    const tree = await render({ tab: 'mom' });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('FRIDAY');
    expect(json).toContain('EDITED BY YOU');
    await act(async () => tree.unmount());
  });

  /**
   * A hand-typed row has no item and no evidence, which is not a failure to find any — it is a
   * row that never claimed any. It keeps its place on the screen it was typed on, and it gets no
   * button offering to play a moment nobody spoke.
   */
  it('keeps a hand-typed decision, and gives it no provenance button', async () => {
    (db.minutes as jest.Mock).mockResolvedValue([
      minute(),
      minute({ id: 'min-user', kind: 'decision', content: 'Ship on the 14th', source: 'user' }),
    ]);
    (db.items as jest.Mock).mockResolvedValue([item()]);

    const tree = await render({ tab: 'mom' });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('Ship on the 14th');
    expect(json).toContain('ADDED BY YOU');
    // One timestamp on the screen: the extracted action's. The typed decision has none.
    expect(byLabel(tree, 'Show this in the transcript at 1:05')).toHaveLength(1);
    expect(json).not.toContain('0:00');
    await act(async () => tree.unmount());
  });
});

describe('the Actions tab', () => {
  /**
   * The gap Task 9 accepted and this task closes: the tab wrote `action_done` keyed on a hash of
   * the text while the cross-meeting worklist wrote `item_done` keyed on the item's id, so a tick
   * made in one was invisible to the other. Read back here through the worklist's OWN loader.
   */
  it('writes a tick both this tab and the worklist can see', async () => {
    const tree = await render({ tab: 'actions' });

    await act(async () => {
      tree.root.findByProps({ accessibilityRole: 'checkbox' }).props.onPress();
    });

    expect(db.setItemDone).toHaveBeenCalledWith('m1', 'it-action', true);
    // Not the text hash, and not both stores: nothing sweeps `action_done` on an untick made
    // elsewhere, so a tick in both would come back after the next reprocess.
    expect(db.setActionDone).not.toHaveBeenCalled();

    expect(await db.doneItems('m1')).toEqual(new Set(['it-action']));

    (db.allActions as jest.Mock).mockResolvedValue([
      {
        meetingId: 'm1',
        meetingTitle: 'Standup',
        createdAt: 1,
        id: 'it-action',
        content: ACTION,
        source: 'rule',
        anchorStartMs: 65_000,
      },
    ]);
    expect((await loadActions())[0].done).toBe(true);

    await act(async () => tree.unmount());
  });

  /**
   * The population that has no id to key on. A typed row keeps the store it has always had, which
   * is what makes this an id-keyed tick for everything that CAN have one rather than a conversion
   * that quietly drops the ticks it cannot move. Task 12 moves the row, and its tick with it.
   */
  it('still ticks a hand-typed action in the store that holds it', async () => {
    const typed = minute({ id: 'min-user', content: 'Call the vendor back', source: 'user' });
    (db.minutes as jest.Mock).mockResolvedValue([minute(), typed]);
    (db.items as jest.Mock).mockResolvedValue([]);

    const tree = await render({ tab: 'actions' });
    const boxes = tree.root.findAllByProps({ accessibilityRole: 'checkbox' });
    const typedBox = boxes.find(b => b.props.accessibilityLabel === 'Call the vendor back')!;

    await act(async () => typedBox.props.onPress());

    expect(db.setActionDone).toHaveBeenCalledWith('m1', itemKey('Call the vendor back'), true);
    expect(db.setItemDone).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });
});

describe('opening an item’s evidence', () => {
  it('switches to the transcript and plays from the anchor', async () => {
    player().hasAudio.mockResolvedValue(true);
    const tree = await render({ tab: 'mom' });

    await act(async () => {
      byLabel(tree, 'Play from 1:05')[0].props.onPress();
    });

    expect(tree.root.findAllByType(TranscriptTab)).toHaveLength(1);
    expect(player().seek).toHaveBeenCalledWith(65_000);
    expect(player().play).toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  /** Audio gone: the tab switch and the scroll happen anyway, and only the playback does not. */
  it('opens the transcript without playing when the recording is gone', async () => {
    const tree = await render({ tab: 'mom' });

    await act(async () => {
      byLabel(tree, 'Show this in the transcript at 1:05')[0].props.onPress();
    });

    const transcript = tree.root.findByType(TranscriptTab);
    expect(transcript.props.scrollToMs).toBe(65_000);
    expect(player().seek).not.toHaveBeenCalled();
    expect(player().play).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  /**
   * Tapping the same item twice has to work, and the millisecond alone cannot say so: the scroll
   * effect is keyed on it, and asking again for a number it already holds is not a change. Two
   * items pulled out of one turn share an anchor as well, so this is not only about double taps.
   */
  it('hands the transcript a fresh request every time, same millisecond or not', async () => {
    const tree = await render({ tab: 'mom' });

    await act(async () => {
      byLabel(tree, 'Show this in the transcript at 1:05')[0].props.onPress();
    });
    const first = tree.root.findByType(TranscriptTab).props.scrollSeq;

    // Back to the MOM tab and tap the very same row again.
    await act(async () => {
      tree.root.findAllByProps({ accessibilityRole: 'tab', accessibilityLabel: 'MOM' })[0].props
        .onPress();
    });
    await act(async () => {
      byLabel(tree, 'Show this in the transcript at 1:05')[0].props.onPress();
    });

    const second = tree.root.findByType(TranscriptTab);
    expect(second.props.scrollToMs).toBe(65_000);
    expect(second.props.scrollSeq).not.toBe(first);
    await act(async () => tree.unmount());
  });
});

/**
 * The other half of the same problem, at the component that actually scrolls.
 *
 * `scrollSeq` is in the effect's dependency list and read nowhere in its body, which is exactly
 * the sort of line a later reader deletes as dead. These two cases are what make deleting it fail.
 */
describe('TranscriptTab scrolling twice', () => {
  const turns = [
    utterance(),
    utterance({ id: 'u2', startMs: 60_000, endMs: 70_000, text: 'I will update the roadmap.' }),
  ];

  // Both arrays are hoisted, and that is not tidiness: TranscriptTab's scroll effect depends on
  // the turns it built, so a fresh `speakers={[]}` literal on every render rebuilds them and
  // re-fires the scroll — which would make the second case below pass for the wrong reason.
  const speakers: never[] = [];
  const draw = (scrollToMs: number, scrollSeq: number) => (
    <TranscriptTab
      utterances={turns}
      speakers={speakers}
      scrollToMs={scrollToMs}
      scrollSeq={scrollSeq}
    />
  );

  it('scrolls again when the same moment is asked for again', () => {
    jest.useFakeTimers();
    const scroll = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    try {
      let tree!: renderer.ReactTestRenderer;
      act(() => {
        tree = renderer.create(draw(65_000, 1));
      });
      act(() => {
        jest.advanceTimersByTime(200);
      });
      expect(scroll).toHaveBeenCalledTimes(1);

      act(() => {
        tree.update(draw(65_000, 2));
      });
      act(() => {
        jest.advanceTimersByTime(200);
      });
      expect(scroll).toHaveBeenCalledTimes(2);
      act(() => tree.unmount());
    } finally {
      scroll.mockRestore();
      jest.useRealTimers();
    }
  });

  it('does not scroll again when nothing was asked for', () => {
    jest.useFakeTimers();
    const scroll = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    try {
      let tree!: renderer.ReactTestRenderer;
      act(() => {
        tree = renderer.create(draw(65_000, 1));
      });
      act(() => {
        jest.advanceTimersByTime(200);
      });
      act(() => {
        tree.update(draw(65_000, 1));
      });
      act(() => {
        jest.advanceTimersByTime(200);
      });
      expect(scroll).toHaveBeenCalledTimes(1);
      act(() => tree.unmount());
    } finally {
      scroll.mockRestore();
      jest.useRealTimers();
    }
  });
});
