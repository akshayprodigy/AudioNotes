import React from 'react';
import renderer, { act } from 'react-test-renderer';
import LibraryScreen from '../LibraryScreen';
import { db } from '../../db/queries';
import { useLibraryStore } from '../../state/libraryStore';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

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
const route = { key: 'library', name: 'Library', params: undefined } as never;

const sweepItems = jest.fn<Promise<boolean>, []>();

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
  sweepItems.mockResolvedValue(false);
  // The real actions are replaced rather than driven: the store's own tests cover the latch, the
  // batching and the retry policy, and leaving the real ones in would make this file's outcome
  // depend on a module-level latch shared with every other test in the process.
  useLibraryStore.setState({ backfillItems: sweepItems, backfillSearch: jest.fn() });
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
  sweepItems.mockResolvedValue(false);

  const tree = await focusTheLibrary();

  expect(db.allActions).toHaveBeenCalledTimes(1);

  await act(async () => tree.unmount());
});
