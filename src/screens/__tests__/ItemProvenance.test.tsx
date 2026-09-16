import React from 'react';
import { FlatList } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import MeetingScreen from '../MeetingScreen';
import TranscriptTab from '../meeting/TranscriptTab';
import { ProvenanceButton, provenanceLabel } from '../meeting/ItemProvenance';
import { editTargetOf, isItemKind, itemKey, toItemRows } from '../meeting/shared';
import { TextPrompt } from '../../components/ui';
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
  itemType: null,
  status: null,
  ownerJson: null,
  dateSaid: null,
  dateNorm: null,
  anchorStartMs: 65_000,
  anchorEndMs: 69_000,
  sources: [{ startMs: 65_000, endMs: 69_000, charStart: 0, charEnd: 40, utteranceId: 'u2' }],
  ...over,
});

/**
 * A decision a person typed themselves, as it comes back out of `items` after Task 12.
 *
 * `anchorStartMs` is null because db.items derives it there from `gen_version`; the sentinel the
 * column really holds never reaches a screen. `sources` is empty because the row never claimed any
 * — which is what withholds the provenance button, and why it is not the same thing as an
 * extracted item whose evidence could not be resolved.
 */
const typedDecision = (over: Partial<Item> = {}): Item =>
  item({
    id: 'it-typed',
    kind: 'decision',
    text: 'Ship on the 14th',
    review: 'confirmed',
    genVersion: 'user',
    anchorStartMs: null,
    anchorEndMs: null,
    sources: [],
    ...over,
  });

/** An action a person typed themselves, the twin of [typedDecision] on the tab that matters most. */
const typedAction = (over: Partial<Item> = {}): Item =>
  typedDecision({ id: 'it-typed-action', kind: 'action', text: 'Book the venue — Priya', ...over });

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

/**
 * THE MIRROR. `FileExportModule.stamp` in Kotlin reproduces this function, because an exported
 * document has to say the same time about an item as the screen it was exported from — and
 * ExportItemsTest asserts THESE VALUES, the way ItemKeyTest asserts `itemKey`'s. Two
 * implementations of one format are two chances to drift, and a shared table is the only thing
 * that stops them; change a case here and change it there.
 *
 * The hour boundary is in the table because it is where a format like this actually breaks. An
 * hour-long meeting is ordinary, `59:59` and `1:00:00` are one millisecond apart, and a dropped
 * zero-pad on the middle field would read `1:0:00` for a whole hour of every long meeting.
 */
describe('provenanceLabel', () => {
  it('reads as a timestamp a person can find in the recording', () => {
    expect(provenanceLabel(0)).toBe('0:00');
    expect(provenanceLabel(65_000)).toBe('1:05');
    expect(provenanceLabel(3_599_999)).toBe('59:59');
    expect(provenanceLabel(3_600_000)).toBe('1:00:00');
    expect(provenanceLabel(3_725_000)).toBe('1:02:05');
  });

  /**
   * The clamp, with a WHOLE negative second and not just `-1`, because the two languages disagree
   * about what `-1` even is: `Math.floor(-1 / 1000)` is `-1` here and `-1 / 1000` truncates to `0`
   * in Kotlin, so the `-1` case exercises the clamp on this side and nothing at all on the other.
   * Found by mutation-testing the Kotlin mirror, not by reading either.
   */
  it('does not run backwards on a nonsense anchor', () => {
    expect(provenanceLabel(-1_000)).toBe('0:00');
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
   * A hand-typed row is an ITEM now, and it is `mine` because of `gen_version`, not because of
   * which table it came out of.
   *
   * It has an id — so its tick and its correction are keyed on something a re-wording cannot move
   * — and no anchor, because it never claimed a moment. Both tabs gate the provenance button on
   * `anchorStartMs !== null`, so the null is what withholds it.
   */
  it('gives a hand-typed item its id, marks it mine, and gives it no anchor', () => {
    const typed = item({
      id: 'it-typed',
      kind: 'decision',
      text: 'Ship on the 14th',
      genVersion: 'user',
      review: 'confirmed',
      anchorStartMs: null,
      anchorEndMs: null,
      sources: [],
    });
    const rows = toItemRows([item(), typed], []);
    expect(rows.map(r => r.text)).toEqual([ACTION, 'Ship on the 14th']);
    expect(rows[1]).toMatchObject({ itemId: 'it-typed', minuteId: null, anchorStartMs: null });
    expect(rows[1].mine).toBe(true);
    // The extracted row is still not mine and still has its moment: a `mine` that was true for
    // every row, or an anchor nulled for every row, would pass an assertion on the typed one alone.
    expect(rows[0]).toMatchObject({ mine: false, anchorStartMs: 65_000 });
  });

  /**
   * The transitional half Task 12 removes: a `minutes` row with source='user' is no longer merged
   * back in, because `AudioDb.carryUserMinutesOntoItems` has moved it into `items` and deleted it.
   *
   * The fixture is the state that used to produce TWO rows for one sentence — a migrated meeting
   * still holding the minutes row it was migrated from. Rendering both is what this drops.
   */
  it('no longer merges a hand-typed minutes row into a meeting that has items', () => {
    const typed = minute({ id: 'min-user', content: 'Call the vendor back', source: 'user' });
    const rows = toItemRows([item()], [minute(), typed]);
    expect(rows.map(r => r.text)).toEqual([ACTION]);
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

  /**
   * THE HOLE TASK 12 OPENS, and the reason the fallback asks about RULE rows rather than about
   * rows.
   *
   * `carryUserMinutesOntoItems` runs before the native load, so an unmigrated meeting somebody has
   * typed a decision into arrives here with exactly one item — the typed one — and all of its
   * rule-extracted minutes still in `minutes`. Under "does this meeting have any items at all" the
   * fallback switches OFF at that moment and the entire MOM disappears, leaving the one line the
   * person typed. Nothing fails, nothing is deleted, and the tab is empty but for their own note.
   */
  it('still falls back to the minutes for a meeting whose only item is hand-typed', () => {
    const typed = item({
      id: 'it-typed',
      kind: 'decision',
      text: 'Ship on the 14th',
      genVersion: 'user',
      anchorStartMs: null,
      anchorEndMs: null,
      sources: [],
    });
    const rows = toItemRows([typed], [minute(), minute({ id: 'min-sum', kind: 'summary' })]);
    expect(rows.map(r => r.text)).toEqual(['Ship on the 14th', ACTION]);
    expect(rows[1]).toMatchObject({ itemId: null, minuteId: 'min-action', anchorStartMs: null });
  });

  /**
   * The list the add path and the merge are both written from.
   *
   * `isItemKind` is a type GUARD, which is what makes the compiler enforce the split — routing a
   * `summary` to `db.addUserItem` is a type error rather than a runtime surprise — but the
   * membership itself is a claim about this app's vocabulary and nothing else pins it.
   */
  it('counts the three list kinds as items and the three prose kinds as documents', () => {
    expect(['decision', 'action', 'question'].map(isItemKind)).toEqual([true, true, true]);
    expect(['summary', 'narrative', 'headline'].map(isItemKind)).toEqual([false, false, false]);
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
 * WHERE A CORRECTION IS STORED, now that a row can have an id worth keying on.
 *
 * An item is corrected under `item/<items.id>`, which is what makes a correction survive the item
 * being RE-WORDED by a reprocess — the same property `item_done` gives a tick, and one a text hash
 * cannot have, because the hash moves with the text. A row that has no item keeps the
 * `minute/<hash>` key it has always had, because there is nothing else to key it on.
 *
 * Both shapes are live at once, deliberately and transitionally, exactly as two tick stores are:
 * A meeting whose migration has not run has every row in `minutes` and no item to key on.
 */
describe('editTargetOf', () => {
  it('keys an extracted item on its id, which a re-wording cannot move', () => {
    expect(editTargetOf(toItemRows([item()], [])[0])).toEqual({ kind: 'item', key: 'it-action' });
  });

  /**
   * The population that still has no id: every row of a meeting whose migration has not run. A
   * hand-typed row left this population in Task 12 — it is an item now, keyed on its own id — and
   * an unmigrated meeting's rows have not, which is why the `minute/<hash>` shape stays live.
   */
  it('keys a row with no item on the hash of its stored text, having nothing else', () => {
    const rows = toItemRows([], [minute({ id: 'min-x', content: 'Call the vendor back' })]);
    expect(editTargetOf(rows[0])).toEqual({
      kind: 'minute',
      key: itemKey('Call the vendor back'),
    });
  });

  /** A hand-typed item is keyed on its id, exactly as an extracted one is. */
  it('keys a hand-typed item on its id too', () => {
    const typed = item({ id: 'it-typed', genVersion: 'user', anchorStartMs: null, sources: [] });
    expect(editTargetOf(toItemRows([typed], [])[0])).toEqual({ kind: 'item', key: 'it-typed' });
  });
});

/**
 * THE PROPERTY THE MIGRATION RESTS ON.
 *
 * Every correction anybody has ever made is a row keyed `target_kind='minute'`,
 * `target_key=itemKey(stored minute content)`. `AudioDb.carryEditsOntoItems` moves each one onto
 * the item that replaced it by hashing the ITEM's text and looking for that key — so the carry
 * finds anything at all only if `itemKey(item.text)` reproduces `itemKey(minute.content)`.
 *
 * It does, because `Minutes.extract` and `Minutes.extractItems` are the same rules over the same
 * turns — the property `AudioDb.backfillItems` already bets every tick in every existing library
 * on. The two strings are not byte-identical in every case: `extractItems` asciifies non-breaking
 * spaces before splitting sentences and `extractMinutes` does not. `itemKey` collapses every
 * whitespace run to one space before hashing, so that difference cannot reach the key, which is
 * what the second case here pins. BackfillEditsTest is the same property against real SQLCipher
 * and the real extractors; this is the arithmetic it depends on.
 */
describe('the edits key survives the move from minutes to items', () => {
  it('hashes an item to the key its minute already had', () => {
    expect(itemKey(item().text)).toBe(itemKey(minute().content));
    expect(toItemRows([item()], [])[0].textKey).toBe(itemKey(minute().content));
  });

  it('is blind to the one way the two extractors differ', () => {
    // Escaped, not typed. A literal U+00A0 in the source renders as an ordinary space in every
    // terminal and diff, so these two lines read as a tautology and the next person deletes them.
    // The name is what makes the assertion legible.
    const NBSP = '\u00a0';
    // Left: what extractMinutes stores — its sentence split uses isspace(), which cannot see a
    // non-breaking space, so the character survives into the minute. Right: what extractItems
    // produces, having asciified whitespace before splitting. Same item, and the key must agree.
    expect(itemKey(`Ana to${NBSP}update the roadmap`)).toBe(itemKey('Ana to update the roadmap'));
    expect(itemKey(`Ana to${NBSP}${NBSP}update`)).toBe(itemKey('Ana to update'));
    // The reason it holds is a property of `itemKey` alone and not of either extractor:
    // JavaScript's `\s` already includes U+00A0, so the fold collapses it whatever produced it.
    expect(NBSP).toMatch(/\s/);
  });
});

// ------------------------------------------------------------------------------------------
// The screen
// ------------------------------------------------------------------------------------------

// `addListener` is what the meeting screen's refresh-on-focus effect subscribes with; it returns
// the unsubscribe. Nothing here fires focus, so the effect is inert in these tests.
const nav = {
  navigate: jest.fn(),
  goBack: jest.fn(),
  setOptions: jest.fn(),
  addListener: jest.fn(() => () => {}),
} as any;

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
  (db.marks as jest.Mock).mockResolvedValue([]);
  (db.removeMark as jest.Mock).mockResolvedValue(undefined);
  (db.stageRates as jest.Mock).mockResolvedValue({});
  (db.setLineSpeaker as jest.Mock).mockResolvedValue(undefined);
  (db.addSpeaker as jest.Mock).mockResolvedValue(null);
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  (db.setSetting as jest.Mock).mockResolvedValue(undefined);

  // One store behind three calls, so a tick written by the tab can be read back by the tab AND by
  // the cross-meeting worklist's own loader rather than merely asserted about.
  //
  // The separator is the NUL `db.doneItemIds` actually joins on, so `loadActions` matches against
  // the real key rather than one this file invented. Written as an escape: a raw NUL in the source
  // makes the whole file binary to grep and diff, which is how one got past review once already.
  const flat = (meetingId: string, itemId: string) => `${meetingId}\u0000${itemId}`;
  (db.setItemDone as jest.Mock).mockImplementation(async (m: string, i: string, on: boolean) => {
    if (on) ticks.add(flat(m, i));
    else ticks.delete(flat(m, i));
  });
  (db.doneItems as jest.Mock).mockImplementation(async (m: string) =>
    new Set([...ticks].filter(k => k.startsWith(`${m}\u0000`)).map(k => k.split('\u0000')[1])),
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

  /** A correction, drawn against the item it belongs to. */
  it('shows a correction written against the item', async () => {
    (db.edits as jest.Mock).mockResolvedValue([
      {
        meetingId: 'm1',
        targetKind: 'item',
        targetKey: 'it-action',
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
   * THE HALF THAT WOULD HAVE FAILED IN SILENCE, pinned as a deliberate consequence.
   *
   * A correction made by any shipped build is keyed on a hash of the MINUTE's text, and this
   * screen no longer looks there for a row that has an item. That is not an oversight to be
   * papered over with a fallback read: a fallback would leave the old row in place forever, and
   * REVERT — which deletes the item-keyed row — would then appear to do nothing, because the
   * stale minute-keyed row would come straight back.
   *
   * So the rows are MOVED instead, by `AudioDb.carryEditsOntoItems`, which runs before anything
   * reads a meeting. This test is what makes the two sides one change rather than two: it fails
   * the moment somebody switches the writer back, or adds the fallback, and BackfillEditsTest on
   * a real database is what proves the correction is not simply lost.
   */
  it('does not read an item\u2019s correction off the minute key any more', async () => {
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
    expect(JSON.stringify(tree.toJSON())).not.toContain('FRIDAY');
    await act(async () => tree.unmount());
  });

  /**
   * And the writer moved with the reader.
   *
   * A one-sided switch is a data-loss bug in whichever direction it goes: a writer still keyed on
   * the text hash writes corrections the exported document cannot find, and a reader switched
   * alone finds nothing anybody has ever written. Driven through the row's own long-press so the
   * key comes from the screen's real path rather than from a handler called directly.
   */
  it('writes a correction against the item id', async () => {
    const tree = await render({ tab: 'mom' });
    await act(async () => {
      tree.root
        .findByProps({ accessibilityHint: 'Long press to correct this line' })
        .props.onLongPress();
    });
    const prompt = tree.root.findAllByType(TextPrompt).find(p => p.props.visible)!;
    expect(prompt.props.initial).toBe(ACTION);
    await act(async () => prompt.props.onSubmit('Ana to update the roadmap by FRIDAY — Ana', ''));
    expect(db.putEdit).toHaveBeenCalledWith(
      'm1',
      'item',
      'it-action',
      'Ana to update the roadmap by FRIDAY — Ana',
    );
    await act(async () => tree.unmount());
  });

  /**
   * A correction to a hand-typed row is keyed on the ITEM's id now, like every other correction.
   *
   * That is the point of Task 12 rather than a side effect: a hand-typed row was the last
   * population still keyed on a hash of its own text, so correcting one and then correcting it
   * again orphaned the first correction the moment the wording moved. The `minute/<hash>` shape
   * stays live only for a meeting whose migration has not run.
   */
  it('shows a correction to a hand-typed item, keyed on its id', async () => {
    (db.items as jest.Mock).mockResolvedValue([item(), typedDecision()]);
    (db.edits as jest.Mock).mockResolvedValue([
      {
        meetingId: 'm1',
        targetKind: 'item',
        targetKey: 'it-typed',
        content: 'Ship on the 21st',
        editedAt: 2,
      },
    ]);
    const tree = await render({ tab: 'mom' });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('Ship on the 21st');
    expect(json).not.toContain('Ship on the 14th');
    await act(async () => tree.unmount());
  });

  /**
   * A hand-typed row cites nothing, which is not a failure to find evidence — it is a row that
   * never claimed any. It gets no button offering to play a moment nobody spoke, and above all no
   * `[0:00]`, which is what `anchor_start_ms = 0` would have printed.
   *
   * TWO ROWS, and the extracted one is what makes this falsifiable: a screen that had stopped
   * drawing provenance buttons at all would pass an assertion that only counted the typed row's.
   */
  it('keeps a hand-typed decision, and gives it no provenance button', async () => {
    (db.items as jest.Mock).mockResolvedValue([item(), typedDecision()]);

    const tree = await render({ tab: 'mom' });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('Ship on the 14th');
    expect(json).toContain('ADDED BY YOU');
    // One timestamp on the screen: the extracted action's. The typed decision has none.
    expect(byLabel(tree, 'Show this in the transcript at 1:05')).toHaveLength(1);
    expect(json).not.toContain('0:00');
    await act(async () => tree.unmount());
  });

  /**
   * Removing it deletes the ITEM, not a `minutes` row that no longer exists.
   *
   * The remove gesture used to be gated on `r.minuteId`, which a hand-typed row no longer has, so
   * leaving that gate in place would have taken the remove button off the only rows that have
   * ever had one — no error, no failing type, just a button that quietly stopped being drawn.
   */
  it('removes a hand-typed decision from items', async () => {
    (db.items as jest.Mock).mockResolvedValue([item(), typedDecision()]);

    const tree = await render({ tab: 'mom' });
    const remove = byLabel(tree, 'Remove this item')[0];
    await act(async () => remove.props.onPress());

    expect(db.removeUserItem).toHaveBeenCalledWith('m1', 'it-typed');
    expect(db.deleteUserMinute).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  /**
   * And an unmigrated meeting's hand-typed row still deletes from `minutes`, because that is still
   * where it lives. One gesture, two stores, dispatched on the row's own identity.
   */
  it('removes a hand-typed minute from minutes when the meeting has no items', async () => {
    (db.items as jest.Mock).mockResolvedValue([]);
    (db.minutes as jest.Mock).mockResolvedValue([
      minute(),
      minute({ id: 'min-user', kind: 'decision', content: 'Ship on the 14th', source: 'user' }),
    ]);

    const tree = await render({ tab: 'mom' });
    const remove = byLabel(tree, 'Remove this item')[0];
    await act(async () => remove.props.onPress());

    expect(db.deleteUserMinute).toHaveBeenCalledWith('m1', 'min-user');
    expect(db.removeUserItem).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  /**
   * Typing a decision writes an `items` row, and typing a SUMMARY still writes a `minutes` row.
   *
   * The split is the kind and nothing else: `summary`, `narrative` and `headline` are documents —
   * one of each per meeting, no anchor, no tick, no provenance — and `items` has nothing to offer
   * them. Routing every add to `addUserItem` would put prose in the list tables and give the MOM
   * tab a row containing the whole write-up.
   */
  it('writes a typed decision to items', async () => {
    const tree = await render({ tab: 'mom' });
    const add = byLabel(tree, 'Add a decision')[0];
    await act(async () => add.props.onPress());
    const prompt = tree.root.findAllByType(TextPrompt).find(pr => pr.props.visible)!;
    await act(async () => prompt.props.onSubmit('Ship on the 14th', ''));

    expect(db.addUserItem).toHaveBeenCalledWith('m1', 'decision', 'Ship on the 14th');
    expect(db.addUserMinute).not.toHaveBeenCalled();
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
   * The Done section is where somebody coming back to a list is looking, and it had no evidence
   * links at all.
   *
   * The row's metadata line was gated on `!on` — written for the owner and due-date chips, which
   * are marks of work in progress and rightly disappear when the work is finished. The timestamp
   * is not that: checking an item off is precisely when a reader wants to verify it. Nothing
   * rendered a finished row before this test, in this suite or any other, which is how the button
   * came to be folded into someone else's rule without anything failing.
   */
  it('keeps the timestamp on a ticked action, and drops the work chips', async () => {
    (db.doneItems as jest.Mock).mockResolvedValue(new Set(['it-action']));

    const tree = await render({ tab: 'actions' });

    // Nothing outstanding, so the row exists only behind the DONE disclosure.
    expect(byLabel(tree, 'Show this in the transcript at 1:05')).toHaveLength(0);

    const fold = tree.root
      .findAllByProps({ accessibilityRole: 'button' }, { deep: false })
      .find(b => b.props.accessibilityState?.expanded === false)!;
    await act(async () => fold.props.onPress());

    expect(byLabel(tree, 'Show this in the transcript at 1:05')).toHaveLength(1);
    // The chips still go: "Ana" and the due date belong to working on it, and the item is done.
    expect(JSON.stringify(tree.toJSON())).not.toContain('due Thursday');

    await act(async () => tree.unmount());
  });

  /**
   * The population that has no id to key on. A typed row keeps the store it has always had, which
   * is what makes this an id-keyed tick for everything that CAN have one rather than a conversion
   * that quietly drops the ticks it cannot move. A HAND-TYPED row left this population in Task 12
   * — `carryUserMinutesOntoItems` moved its tick into `item_done` along with it — so the fixture
   * here is an unmigrated MEETING, which is the population that is left.
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

  /**
   * REMOVING A HAND-TYPED ACTION, which is the half the MOM tab's two remove tests cannot reach.
   *
   * Reverting this tab's gate to the old `r.mine && r.minuteId` left all 342 tests passing while
   * the identical mutation on MinutesTab was killed — both remove tests sat under
   * `describe('the MOM tab')` and this describe had none. The defect is the one this task's own
   * comment names: a hand-typed row stopped having a `minuteId` when it became an `items` row, so
   * the gate silently stops drawing the button. An ACTION is the more common case and the one the
   * whole worklist argument is about.
   */
  it('removes a hand-typed action from items', async () => {
    (db.items as jest.Mock).mockResolvedValue([item(), typedAction()]);

    const tree = await render({ tab: 'actions' });
    const remove = byLabel(tree, 'Remove this item')[0];
    await act(async () => remove.props.onPress());

    expect(db.removeUserItem).toHaveBeenCalledWith('m1', 'it-typed-action');
    expect(db.deleteUserMinute).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  /** And an unmigrated meeting's typed action still deletes from `minutes`, where it still lives. */
  it('removes a hand-typed action from minutes when the meeting has no items', async () => {
    (db.items as jest.Mock).mockResolvedValue([]);
    (db.minutes as jest.Mock).mockResolvedValue([
      minute(),
      minute({ id: 'min-user', content: 'Call the vendor back', source: 'user' }),
    ]);

    const tree = await render({ tab: 'actions' });
    const remove = byLabel(tree, 'Remove this item')[0];
    await act(async () => remove.props.onPress());

    expect(db.deleteUserMinute).toHaveBeenCalledWith('m1', 'min-user');
    expect(db.removeUserItem).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });
});

/**
 * THE FIFTH READER, and the one nothing in this branch had ever counted.
 *
 * The Summary tab's "2 actions · 1 decision · 0 open" strip counted `minutes` rows. A hand-typed
 * decision WAS a `minutes` row, so it was counted; it is an `items` row now and
 * `carryUserMinutesOntoItems` deletes the row it came from. So a newly typed action never
 * incremented the counter, the migration DECREMENTED it by however many rows a person had typed,
 * and — because the whole strip is gated on `actions + decisions + questions > 0` — a meeting
 * whose only item-kind content is hand-typed lost the block entirely, where it had said
 * "2 actions".
 *
 * Nothing failed, because the pipeline still writes rule rows to both tables, so only the
 * hand-typed contribution went missing. And nothing anywhere had ever tested these counters.
 *
 * The counter counts `toItemRows(items, minutes)` now — the same call the two tabs it links to
 * make — so it is right by construction rather than by two tables happening to hold the same
 * sentences. The fixtures below are the states where those two answers differ.
 */
describe('the Summary tab’s counters', () => {
  /**
   * The strip, read off the labels a screen reader is given — "3 actions", "1 decision", "0 open".
   *
   * Asserting the accessibility label rather than a number buried in the rendered tree pins the
   * singular/plural too, and it is the string somebody who cannot see the strip actually receives.
   * An empty array means the whole block was not rendered, which is its own failure mode here.
   */
  const glances = (tree: renderer.ReactTestRenderer): string[] =>
    tree.root
      .findAllByProps({ accessibilityRole: 'button' }, { deep: false })
      .map(b => String(b.props.accessibilityLabel))
      .filter(l => /^\d+ (actions?|decisions?|open)$/.test(l));

  /**
   * A hand-typed action is counted. TWO rule actions in the fixture, so a counter stuck on the
   * item count, on the minute count, or on 1 cannot pass.
   */
  it('counts a hand-typed action alongside the extracted ones', async () => {
    (db.items as jest.Mock).mockResolvedValue([
      item(),
      item({ id: 'it-2', text: 'Send the report — Sam' }),
      typedAction(),
    ]);
    (db.minutes as jest.Mock).mockResolvedValue([
      minute(),
      minute({ id: 'min-2', content: 'Send the report — Sam' }),
    ]);

    const tree = await render({ tab: 'summary' });

    expect(glances(tree)).toEqual(['3 actions', '0 decisions', '0 open']);
    await act(async () => tree.unmount());
  });

  /**
   * THE DISAPPEARANCE. A meeting whose only item-kind content is hand-typed showed no strip at
   * all after the migration deleted the `minutes` row the count was reading.
   */
  it('still shows the strip for a meeting whose only content is hand-typed', async () => {
    (db.items as jest.Mock).mockResolvedValue([typedAction(), typedDecision()]);
    (db.minutes as jest.Mock).mockResolvedValue([]);

    const tree = await render({ tab: 'summary' });

    expect(glances(tree)).toEqual(['1 action', '1 decision', '0 open']);
    await act(async () => tree.unmount());
  });

  /**
   * THE SAME QUESTION, ASKED WHERE IT DECIDES WHETHER THE TABS EXIST AT ALL.
   *
   * `MeetingScreen`'s own "is there anything written about this meeting" guard was
   * `minutes.length === 0`, which was right only while every decision and action lived in both
   * tables. A meeting whose rules extracted nothing and that somebody then typed a decision into
   * has exactly one row and it is an `items` row — so the screen answered "nothing here" and drew
   * "Writing your notes…" over the note they had typed themselves. Before Task 12 that note was a
   * `minutes` row and the tabs were drawn. The counter fix above cannot be reached at all until
   * this one is, which is how it was found.
   */
  it('opens onto the tabs for a meeting whose only content is hand-typed', async () => {
    (db.items as jest.Mock).mockResolvedValue([typedAction()]);
    (db.minutes as jest.Mock).mockResolvedValue([]);

    const tree = await render({ tab: 'summary' });

    expect(byLabel(tree, 'MOM')).toHaveLength(1);
    expect(JSON.stringify(tree.toJSON())).not.toContain('Writing your notes');
    await act(async () => tree.unmount());
  });

  /**
   * THE SIXTH READER OF THE SAME QUESTION, and the only one whose failure is invisible on screen.
   *
   * `refresh()` returns "is there anything written about this meeting yet", and the effect above
   * it polls every two seconds — up to sixty times — while that is 0, waiting for a pipeline that
   * is still writing. It returned `mins.length`. For a meeting whose rules extracted nothing and
   * that somebody typed a decision into, that is now 0 forever: eight bridge queries every two
   * seconds for two minutes after every open, seven `setState` calls and three `toItemRows` memos
   * each time, on a phone.
   *
   * Nothing LOOKS wrong, because `working` and `empty` were already fixed to read both tables —
   * which is exactly why this needs a test rather than an eye. The first sign of it was jest
   * warning that it could not exit after these Summary tests, because the timer outlived them.
   */
  it('stops polling for a meeting whose only content is hand-typed', async () => {
    jest.useFakeTimers();
    try {
      (db.items as jest.Mock).mockResolvedValue([typedAction()]);
      (db.minutes as jest.Mock).mockResolvedValue([]);

      const tree = await render({ tab: 'summary' });
      const afterFirstLoad = (db.minutes as jest.Mock).mock.calls.length;

      // Three ticks' worth. A poll that has not stopped re-reads the meeting on every one.
      await act(async () => {
        jest.advanceTimersByTime(6500);
      });

      // The number of RE-READS, not `jest.getTimerCount()`: the screen has other timers of its
      // own (the entrance animations among them), so a pending timer says nothing about the poll.
      // What the poll does, and the only thing it does, is call `refresh` again.
      expect((db.minutes as jest.Mock).mock.calls.length).toBe(afterFirstLoad);
      await act(async () => tree.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * ...and it still polls for a meeting that genuinely has nothing yet, which is what the poll is
   * FOR: a recording whose pipeline is still running has no minutes and no items, and the screen
   * has to keep looking. A fix that simply stopped polling would pass the test above.
   */
  it('keeps polling for a meeting that has nothing written yet', async () => {
    jest.useFakeTimers();
    try {
      (db.items as jest.Mock).mockResolvedValue([]);
      (db.minutes as jest.Mock).mockResolvedValue([]);

      const tree = await render({ tab: 'summary' });
      const afterFirstLoad = (db.minutes as jest.Mock).mock.calls.length;

      await act(async () => {
        jest.advanceTimersByTime(2500);
      });

      expect((db.minutes as jest.Mock).mock.calls.length).toBeGreaterThan(afterFirstLoad);
      await act(async () => tree.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * And it counts each sentence ONCE for a meeting that holds it in both tables.
   *
   * That is the ordinary state of every migrated meeting: `replaceMinutes` still writes the item
   * kinds to `minutes` because a meeting nobody has opened has not been migrated and its `minutes`
   * are all it has. Counting both tables would double every extracted row.
   */
  it('counts a sentence held in both tables once', async () => {
    (db.items as jest.Mock).mockResolvedValue([item()]);
    (db.minutes as jest.Mock).mockResolvedValue([minute()]);

    const tree = await render({ tab: 'summary' });

    expect(glances(tree)).toEqual(['1 action', '0 decisions', '0 open']);
    await act(async () => tree.unmount());
  });

  /**
   * An unmigrated meeting counts its `minutes`, which is what the tabs draw for it.
   *
   * The counter and the tab it links to have to agree in every state, and this is the state where
   * agreeing means reading the OTHER table.
   */
  it('counts an unmigrated meeting’s minutes, as the tabs do', async () => {
    (db.items as jest.Mock).mockResolvedValue([]);
    (db.minutes as jest.Mock).mockResolvedValue([
      minute(),
      minute({ id: 'min-d', kind: 'decision', content: 'Ship on the 14th' }),
    ]);

    const tree = await render({ tab: 'summary' });

    expect(glances(tree)).toEqual(['1 action', '1 decision', '0 open']);
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
