import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Alert } from 'react-native';
import LibraryScreen from '../LibraryScreen';
import { db } from '../../db/queries';
import { useLibraryStore } from '../../state/libraryStore';
import { entitlement } from '../../billing/trial';
import Licence from '../../native/NativeLicence';
import { useAllowanceStore } from '../../billing/allowance';
import { exhaustedCopy } from '../../billing/allowanceCopy';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// Only entitlement is faked; nudgeState/noteNudgeShown/refuseNudge/shouldNudgeForPro stay real —
// they are already exercised against the mocked `db` exactly as production reads them.
jest.mock('../../billing/trial', () => ({
  ...jest.requireActual('../../billing/trial'),
  entitlement: jest.fn(),
}));

/** An IconButton's press lives on the Pressable inside its Raised, not on the labelled wrapper. */
const pressIconButton = (tree: renderer.ReactTestRenderer, label: string) => {
  const [wrapper] = tree.root.findAllByProps({ accessibilityLabel: label }, { deep: false });
  wrapper.find(n => typeof n.props.onPress === 'function').props.onPress();
};

/**
 * The library's focus effect, and specifically that the item migration has a caller.
 *
 * This is the failure this sub-project has now shipped once: `StorageModule.ensureItems` was
 * written, reviewed, device-verified and merged with nothing in JavaScript calling it, so no
 * meeting recorded before items existed ever gained any and every screen reading `items` drew
 * empty. Nothing failed to compile then and nothing would now — a sweep with no call site is a
 * function that passes all of its own tests.
 *
 * The loop itself is not tested here; libraryStore.test.ts owns it. What is pinned here is the
 * wiring, and the one thing the wiring has to get right beyond existing: the outstanding-actions
 * card is counted on focus, BEFORE the sweep has migrated anything, so a first focus after an
 * update would draw "0 outstanding" over a library full of unticked work and leave it there until
 * the user navigated away and back.
 */
const nav = { navigate: jest.fn(), addListener: jest.fn(() => jest.fn()) } as never;

/** A native event, delivered the way the phone would deliver it (jest.setup.js). */
const emit = (name: string, payload: unknown) => (global as any).__TEST_EMIT__(name, payload);
const route = { key: 'library', name: 'Library', params: undefined } as never;

const sweepItems = jest.fn<Promise<boolean>, []>();
const sweepSearch = jest.fn<Promise<void>, []>();

async function focusTheLibrary() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<LibraryScreen navigation={nav} route={route} />);
  });
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  (db.listMeetings as jest.Mock).mockResolvedValue([]);
  (db.allTags as jest.Mock).mockResolvedValue([]);
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  (db.archivedCount as jest.Mock).mockResolvedValue(0);
  (db.allActions as jest.Mock).mockResolvedValue([]);
  (db.doneItemIds as jest.Mock).mockResolvedValue(new Set<string>());
  (db.pendingMeetings as jest.Mock).mockResolvedValue([]);
  sweepItems.mockReset();
  sweepItems.mockResolvedValue(false);
  sweepSearch.mockReset();
  sweepSearch.mockResolvedValue(undefined);
  (entitlement as jest.Mock).mockResolvedValue({ paid: true });
  // The real actions are replaced rather than driven: the store's own tests cover the latch, the
  // batching and the retry policy, and leaving the real ones in would make this file's outcome
  // depend on a module-level latch shared with every other test in the process.
  useLibraryStore.setState({ backfillItems: sweepItems, backfillSearch: sweepSearch, tag: null });
});

describe('the title at large text', () => {
  test('"Meetings" stays on one line and shrinks to fit rather than breaking mid-word', async () => {
    const { Text } = require('react-native');
    const tree = await focusTheLibrary();
    const title = tree.root.find(n => n.type === Text && n.props.children === 'Meetings');
    expect(title.props.numberOfLines).toBe(1);
    expect(title.props.adjustsFontSizeToFit).toBe(true);
    await act(async () => tree.unmount());
  });
});

describe('the thread door and the Pro-gated worklist (Phase 3)', () => {
  test('no "Open thread" without a selected tag', async () => {
    (db.allTags as jest.Mock).mockResolvedValue([{ name: 'client', n: 2 }]);
    const tree = await focusTheLibrary();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Open thread' }, { deep: false })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Open thread (Pro)' }, { deep: false })).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  test('with a tag selected and paid, "Open thread" appears and navigates to Thread with that tag', async () => {
    (db.allTags as jest.Mock).mockResolvedValue([{ name: 'client', n: 2 }]);
    const tree = await focusTheLibrary();
    await act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'client · 2' }).props.onPress();
    });

    await act(async () => {
      pressIconButton(tree, 'Open thread');
    });
    expect((nav as any).navigate).toHaveBeenCalledWith('Thread', { tag: 'client' });
    await act(async () => tree.unmount());
  });

  test('on free, the door reads "Open thread (Pro)" and opens the paywall', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    (db.allTags as jest.Mock).mockResolvedValue([{ name: 'client', n: 2 }]);
    const tree = await focusTheLibrary();
    await act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'client · 2' }).props.onPress();
    });

    expect(tree.root.findAllByProps({ accessibilityLabel: 'Open thread' }, { deep: false })).toHaveLength(0);
    await act(async () => {
      pressIconButton(tree, 'Open thread (Pro)');
    });
    expect((nav as any).navigate).toHaveBeenCalledWith('Paywall');
    await act(async () => tree.unmount());
  });

  test('on free the header carries neither a Pro pill nor Actions: the count is the way to Pro', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const tree = await focusTheLibrary();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Actions' }, { deep: false })).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Get Pro' }, { deep: false })).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  test('the outstanding-actions card is not drawn on free', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    (db.allActions as jest.Mock).mockResolvedValue([
      { id: 'i1', meetingId: 'm1', meetingTitle: 'Standup', createdAt: 1, content: 'Send it', source: 'rule', anchorStartMs: 0 },
    ]);
    const tree = await focusTheLibrary();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Open actions' }, { deep: false })).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  test('paid keeps the outstanding-actions card and the plain "Actions" label', async () => {
    (db.allActions as jest.Mock).mockResolvedValue([
      { id: 'i1', meetingId: 'm1', meetingTitle: 'Standup', createdAt: 1, content: 'Send it', source: 'rule', anchorStartMs: 0 },
    ]);
    const tree = await focusTheLibrary();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Open actions' }, { deep: false })).toHaveLength(1);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Actions' }, { deep: false })).toHaveLength(1);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Get Pro' }, { deep: false })).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  test('buying Pro on the Pro screen is noticed when the library is focused again', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const tree = await focusTheLibrary();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Actions' }, { deep: false })).toHaveLength(0);

    (entitlement as jest.Mock).mockResolvedValue({ paid: true });
    const onFocus = (nav as any).addListener.mock.calls.find((c: any[]) => c[0] === 'focus')[1];
    await act(async () => {
      onFocus();
    });
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Actions' }, { deep: false })).toHaveLength(1);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Get Pro' }, { deep: false })).toHaveLength(0);
    await act(async () => tree.unmount());
  });
});

test('focusing the library sweeps the item migration', async () => {
  const tree = await focusTheLibrary();

  expect(sweepItems).toHaveBeenCalledTimes(1);

  await act(async () => tree.unmount());
});

/**
 * `true` means native was asked, so anything counted before the sweep may be stale. The tally is
 * the cross-meeting reader that lives on THIS screen — the worklist and Search recount on their
 * own focus — and it is counted before the sweep runs, which is the whole problem. (Nothing
 * renders `work` yet; see the focus effect for why the re-count goes in anyway.)
 */
test('re-counts outstanding actions when the sweep asked native', async () => {
  sweepItems.mockResolvedValue(true);

  const tree = await focusTheLibrary();

  expect(db.allActions).toHaveBeenCalledTimes(2);

  await act(async () => tree.unmount());
});

/**
 * ...and does not, when the latch short-circuited it. Otherwise every focus for the rest of the
 * install's life pays for two extra library-wide queries to re-derive a number that cannot have
 * changed.
 */
test('does not re-count when the sweep short-circuited', async () => {
  sweepItems.mockReset();
  sweepItems.mockResolvedValue(false);
  sweepSearch.mockReset();
  sweepSearch.mockResolvedValue(undefined);

  const tree = await focusTheLibrary();

  expect(db.allActions).toHaveBeenCalledTimes(1);

  await act(async () => tree.unmount());
});

/**
 * The order of the two sweeps, which ten lines of comment defend and nothing pinned.
 *
 * Both go through one process-wide SQLCipher connection, so running them together is not free
 * parallelism: each batch waits behind the other's on that connection and the yield between passes
 * stops being a yield. And items lead deliberately, because what they repair is a false statement
 * — the worklist and Search's filter both read across meetings — while the search backlog costs
 * results in a screen that already says it may be incomplete. Swapping the two `.then`s would keep
 * every other test in this file green.
 */
test('the item sweep runs before the search sweep', async () => {
  const tree = await focusTheLibrary();

  expect(sweepItems).toHaveBeenCalledTimes(1);
  expect(sweepSearch).toHaveBeenCalledTimes(1);
  expect(sweepItems.mock.invocationCallOrder[0]).toBeLessThan(
    sweepSearch.mock.invocationCallOrder[0],
  );

  await act(async () => tree.unmount());
});

/**
 * ...and IN SEQUENCE, which the call order alone cannot show: `Promise.all` would start both in
 * the same tick and still record the item sweep first. The item sweep is left pending, and the
 * search sweep must not have begun.
 */
test('the search sweep does not start until the item sweep has settled', async () => {
  let release!: (swept: boolean) => void;
  sweepItems.mockImplementation(
    () =>
      new Promise<boolean>(resolve => {
        release = resolve;
      }),
  );

  const tree = await focusTheLibrary();
  expect(sweepSearch).not.toHaveBeenCalled();

  await act(async () => release(false));

  expect(sweepSearch).toHaveBeenCalledTimes(1);

  await act(async () => tree.unmount());
});

/** A meeting the pipeline has paused reads PAUSED, not TRANSCRIBING, and goes back on resume. */
test('badges a paused meeting PAUSED and returns it to TRANSCRIBING on resume', async () => {
  // Through the store's own loader: focusing the library refreshes from the database, so a
  // meeting placed straight into the store would be overwritten by the mock's empty list.
  (db.listMeetings as jest.Mock).mockResolvedValue([{
    id: 'm1', title: 'Standup', createdAt: Date.now(), durationMs: 600_000, language: 'en',
    status: 'vad', tierUsed: 'free', audioRetained: 1,
  }]);
  const tree = await focusTheLibrary();
  expect(JSON.stringify(tree.toJSON())).toContain('TRANSCRIBING');
  await act(async () => { emit('onProcessingPause', { meetingId: 'm1', reason: 'battery' }); });
  expect(JSON.stringify(tree.toJSON())).toContain('PAUSED');
  await act(async () => { emit('onProcessingPause', { meetingId: 'm1', reason: null }); });
  expect(JSON.stringify(tree.toJSON())).toContain('TRANSCRIBING');
  await act(async () => tree.unmount());
});

/** Phase 5: a dictated note says so on its card, before the date. */
test('a dictated note wears Dictation on its card', async () => {
  (db.listMeetings as jest.Mock).mockResolvedValue([{
    id: 'm1', title: 'Note to Priya', createdAt: Date.now(), durationMs: 90_000, language: 'en',
    status: 'done', tierUsed: 'free', audioRetained: 1, mode: 'dictation',
  }]);
  const tree = await focusTheLibrary();
  expect(JSON.stringify(tree.toJSON())).toContain('Dictation · ');
  await act(async () => tree.unmount());
});

/**
 * The action tracker's front door. The screen existed for a month with nothing opening it; the
 * tally that feeds this card was computed on every focus and rendered nowhere.
 */
describe("the action tracker's front door", () => {
  // db.allActions rows carry no `done`; the loader joins doneItemIds (keyed meetingId NUL id) in.
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      meetingId: i === 0 ? 'a' : 'b', id: String(i), content: `item ${i}`, source: 'rule',
      meetingTitle: i === 0 ? 'A' : 'B', createdAt: 1,
    }));
  const doneKey = (meetingId: string, id: string) => `${meetingId}${String.fromCharCode(0)}${id}`;

  it('shows a card with the open count and opens the tracker', async () => {
    (db.allActions as jest.Mock).mockResolvedValue(rows(3));
    (db.doneItemIds as jest.Mock).mockResolvedValue(new Set([doneKey('b', '2')]));
    const tree = await focusTheLibrary();
    const card = tree.root.findByProps({ accessibilityLabel: 'Open actions' });
    // Text nodes render their template pieces as separate children; join them before reading.
    const lines = card.findAllByType(require('react-native').Text).map(t => [].concat(t.props.children).join(''));
    expect(lines).toContain('2 open actions');
    expect(lines).toContain('across 2 meetings');
    await act(async () => { card.props.onPress(); });
    expect((nav as any).navigate).toHaveBeenCalledWith('Actions');
    await act(async () => tree.unmount());
  });

  it('shows no card when nothing is open', async () => {
    (db.allActions as jest.Mock).mockResolvedValue(rows(1));
    (db.doneItemIds as jest.Mock).mockResolvedValue(new Set([doneKey('a', '0')]));
    const tree = await focusTheLibrary();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Open actions' })).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  it('has the tracker one tap away in the header regardless', async () => {
    const tree = await focusTheLibrary();
    const icon = tree.root.findByProps({ label: 'Actions' });
    await act(async () => { icon.props.onPress(); });
    expect((nav as any).navigate).toHaveBeenCalledWith('Actions');
    await act(async () => tree.unmount());
  });
});

test('a crashed meeting reads DIDN\'T FINISH with its reason, not NO SPEECH', async () => {
  (db.listMeetings as jest.Mock).mockResolvedValue([
    {
      id: 'f1', title: 'Crashed', createdAt: Date.now(), durationMs: 600_000, status: 'failed',
      tierUsed: 'free', audioRetained: 1, language: 'en',
      failReason: 'The phone ran out of memory while processing.',
    },
  ]);
  const tree = await focusTheLibrary();
  const text = JSON.stringify(tree.toJSON());
  expect(text).toContain("DIDN'T FINISH");
  expect(text).toContain('ran out of memory');
  expect(text).not.toContain('NO SPEECH');
  await act(async () => tree.unmount());
});

/**
 * The Free allowance in the library (F08), and what an import is told. Pro sees none of it, and
 * an empty allowance never closes a saved meeting: the month's five limit NEW sessions only.
 */
describe('keyword search is Free (F09)', () => {
  test('on Free the search button is plain "Search meetings" and opens Search, not the paywall', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const tree = await focusTheLibrary();
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Search meetings (Pro)' }, { deep: false })).toHaveLength(0);
    await act(async () => {
      pressIconButton(tree, 'Search meetings');
    });
    expect((nav as any).navigate).toHaveBeenCalledWith('Search');
    expect((nav as any).navigate).not.toHaveBeenCalledWith('Paywall');
    await act(async () => tree.unmount());
  });

  test('on Pro it is the same button and the same screen', async () => {
    const tree = await focusTheLibrary();
    await act(async () => {
      pressIconButton(tree, 'Search meetings');
    });
    expect((nav as any).navigate).toHaveBeenCalledWith('Search');
    await act(async () => tree.unmount());
  });
});

describe('the Free allowance', () => {
  test('on an empty library the sub-lines sit under the header row, not squeezed beside the buttons', async () => {
    const tree = await focusTheLibrary();
    const row = tree.root.findAll(n => n.props.testID === 'library-header', { deep: false })[0];
    const inRow = row.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);
    expect(inRow).toContain('Meetings');
    expect(inRow).not.toContain('Nothing recorded yet');
    expect(inRow).not.toContain('3 of 5 free meetings left · resets 1 November.');
    const all = texts(tree);
    expect(all).toContain('Nothing recorded yet');
    expect(all).toContain('3 of 5 free meetings left · resets 1 November.');
    await act(async () => tree.unmount());
  });

  const allowance = Licence.allowance as unknown as jest.Mock;
  const FREE = { limit: 5, used: 2, remaining: 3, period: '2026-10', resetsOn: '2026-11-01', paid: false };
  const importer = (global as any).__TEST_NATIVE_MODULES__.Import;
  const saved = {
    id: 'm1', title: 'Standup', createdAt: Date.now(), durationMs: 600_000, language: 'en',
    status: 'done', tierUsed: 'free', audioRetained: 1,
  };
  const texts = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);

  beforeEach(() => {
    useAllowanceStore.setState({ status: null });
    allowance.mockResolvedValue(FREE);
    importer.pick.mockReset();
    importer.pick.mockResolvedValue(null);
  });

  const summary = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll(n => n.props.testID === 'library-summary')[0]?.props.accessibilityLabel as string | undefined;

  test('the summary strip says what is left and when it resets', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([saved]);
    const tree = await focusTheLibrary();
    expect(summary(tree)).toContain('3 of 5 free meetings left, resets 1 November');
    expect(texts(tree)).toEqual(expect.arrayContaining(['SAVED', 'CAPTURED', 'FREE LEFT', 'Resets 1 Nov']));
    await act(async () => tree.unmount());
  });

  test('Pro sees no allowance line', async () => {
    allowance.mockResolvedValue({ ...FREE, paid: true });
    (db.listMeetings as jest.Mock).mockResolvedValue([saved]);
    const tree = await focusTheLibrary();
    expect(texts(tree).some(t => /free meetings left|FREE LEFT/.test(t))).toBe(false);
    expect(summary(tree)).toBe('1 meeting saved. 10 min captured.');
    await act(async () => tree.unmount());
  });

  const proSheet = (tree: renderer.ReactTestRenderer) =>
    tree.root.findAll(n => n.props.testID === 'pro-compare', { deep: false });

  test('with nothing recorded, the count opens Free-and-Pro, and Get Pro there opens the Pro screen', async () => {
    const tree = await focusTheLibrary();
    expect(proSheet(tree)).toHaveLength(0);
    const [line] = tree.root.findAllByProps(
      { accessibilityLabel: '3 of 5 free meetings left · resets 1 November. Go unlimited with Pro.' },
      { deep: false },
    );
    await act(async () => line.props.onPress());
    expect((nav as any).navigate).not.toHaveBeenCalledWith('Paywall');
    expect(proSheet(tree)).toHaveLength(1);
    expect(texts(tree)).toEqual(expect.arrayContaining(['FREE', 'PRO', 'Meetings', '5 a month', 'Unlimited']));
    await act(async () =>
      tree.root.findAll(n => n.props.label === 'Get Pro' && typeof n.props.onPress === 'function')[0].props.onPress(),
    );
    expect((nav as any).navigate).toHaveBeenCalledWith('Paywall');
    expect(proSheet(tree)).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  test('with meetings saved, the summary strip opens Free-and-Pro on Free', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([saved]);
    const tree = await focusTheLibrary();
    const strip = tree.root.findAll(n => n.props.testID === 'library-summary', { deep: false })[0];
    await act(async () => strip.props.onPress());
    expect((nav as any).navigate).not.toHaveBeenCalledWith('Paywall');
    expect(proSheet(tree)).toHaveLength(1);
    await act(async () => tree.unmount());
  });

  test('with none left the line is still calm, and a saved meeting still opens', async () => {
    allowance.mockResolvedValue({ ...FREE, used: 5, remaining: 0 });
    (db.listMeetings as jest.Mock).mockResolvedValue([saved]);
    const tree = await focusTheLibrary();
    expect(summary(tree)).toContain('0 of 5 free meetings left, resets 1 November');
    const card = tree.root.find(n => typeof n.props.onPress === 'function' && n.props.onLongPress);
    await act(async () => card.props.onPress());
    expect((nav as any).navigate).toHaveBeenCalledWith('Meeting', { meetingId: 'm1' });
    await act(async () => tree.unmount());
  });

  test('with none left the import button explains before it opens the picker, and offers Pro', async () => {
    allowance.mockResolvedValue({ ...FREE, used: 5, remaining: 0 });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await focusTheLibrary();
    await act(async () => {
      pressIconButton(tree, 'Import a recording');
    });
    expect(importer.pick).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    const [, message, buttons] = alert.mock.calls[0] as [string, string, { text: string; onPress?: () => void }[]];
    expect(message).toBe(exhaustedCopy('2026-11-01'));
    await act(async () => buttons.find(b => b.text === 'Get Pro')!.onPress!());
    expect((nav as any).navigate).toHaveBeenCalledWith('Paywall');
    alert.mockRestore();
    await act(async () => tree.unmount());
  });

  test('with meetings left the import button goes straight to the picker', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await focusTheLibrary();
    await act(async () => {
      pressIconButton(tree, 'Import a recording');
    });
    expect(importer.pick).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
    await act(async () => tree.unmount());
  });

  test('a stale zero does not shut the picker: native is asked again first', async () => {
    const tree = await focusTheLibrary();
    // The screen last heard "none left"; a slot has since been given back.
    await act(async () => {
      useAllowanceStore.setState({ status: { ...FREE, used: 5, remaining: 0 } });
    });
    await act(async () => {
      pressIconButton(tree, 'Import a recording');
    });
    expect(importer.pick).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());
  });

  test('a file over the hour is refused with the Free limit and an offer of Pro', async () => {
    importer.pick.mockRejectedValue(Object.assign(new Error('That recording is longer than the 1 hour Free limit'), { code: 'import_too_long' }));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await focusTheLibrary();
    await act(async () => {
      pressIconButton(tree, 'Import a recording');
    });
    const [, message, buttons] = alert.mock.calls[0] as [string, string, { text: string; onPress?: () => void }[]];
    expect(message).toBe('That recording is longer than the 1 hour Free limit. Pro has no length limit.');
    await act(async () => buttons.find(b => b.text === 'Get Pro')!.onPress!());
    expect((nav as any).navigate).toHaveBeenCalledWith('Paywall');
    alert.mockRestore();
    await act(async () => tree.unmount());
  });

  test('an import while recording says to finish recording first, with no upsell', async () => {
    importer.pick.mockRejectedValue(Object.assign(new Error('Finish recording first'), { code: 'recording_in_progress' }));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await focusTheLibrary();
    await act(async () => {
      pressIconButton(tree, 'Import a recording');
    });
    const [, message, buttons] = alert.mock.calls[0] as [string, string, { text: string }[]];
    expect(message).toBe('Finish recording first');
    expect(buttons.map(b => b.text)).not.toContain('Get Pro');
    alert.mockRestore();
    await act(async () => tree.unmount());
  });

  test('a second import while one runs says to finish the import first', async () => {
    importer.pick.mockRejectedValue(Object.assign(new Error('Finish the import first'), { code: 'import_in_progress' }));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await focusTheLibrary();
    await act(async () => {
      pressIconButton(tree, 'Import a recording');
    });
    expect((alert.mock.calls[0] as unknown[])[1]).toBe('Finish the import first');
    alert.mockRestore();
    await act(async () => tree.unmount());
  });

  test('any other failure keeps the old title and the native message', async () => {
    importer.pick.mockRejectedValue(Object.assign(new Error('There is no audio in that file'), { code: 'import_failed' }));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await focusTheLibrary();
    await act(async () => {
      pressIconButton(tree, 'Import a recording');
    });
    expect(alert).toHaveBeenCalledWith('Could not import that', 'There is no audio in that file');
    alert.mockRestore();
    await act(async () => tree.unmount());
  });

  test('a shared file is confirmed with the allowance line and the explainer on Free, and not on Pro', async () => {
    importer.consumePendingImport.mockResolvedValueOnce({ uri: 'content://x', name: 'Voice note' });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const tree = await focusTheLibrary();
    const free = (alert.mock.calls[0] as unknown[])[1] as string;
    expect(free).toContain('“Voice note” will be transcribed on this phone. Nothing is uploaded.');
    expect(free).toContain('3 of 5 free meetings left · resets 1 November.');
    expect(free).toContain('Imports and dictations count as meetings.');
    await act(async () => tree.unmount());

    alert.mockClear();
    allowance.mockResolvedValue({ ...FREE, paid: true });
    useAllowanceStore.setState({ status: null });
    importer.consumePendingImport.mockResolvedValueOnce({ uri: 'content://y', name: 'Voice note' });
    const tree2 = await focusTheLibrary();
    const pro = (alert.mock.calls[0] as unknown[])[1] as string;
    expect(pro).toBe('“Voice note” will be transcribed on this phone. Nothing is uploaded.');
    alert.mockRestore();
    await act(async () => tree2.unmount());
  });
});
