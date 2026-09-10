import { create } from 'zustand';
import { db, type MeetingSort } from '../db/queries';
import type { Meeting } from '../pipeline/types';

/**
 * How many meetings one backfill pass hands to native.
 *
 * Small on purpose. Each pass reads a meeting's utterances, minutes, title and summary and writes
 * them into FTS5, which is real work on the native side; a batch of twelve keeps any single call
 * short enough that it never becomes the reason a focus transition drops frames, and the loop
 * below simply runs more of them.
 */
const BATCH = 12;

/**
 * A hard stop on the loop. Twelve meetings a pass means this covers a library of ~4,800 — far
 * beyond anything real — and exists only so a native implementation that ever stopped making
 * progress could not spin the app forever.
 */
const MAX_PASSES = 400;

/**
 * How many meetings one ITEM-migration pass hands to native.
 *
 * The same number as [BATCH] and deliberately its own constant, because it is bounded by
 * different work: a pass here reads a meeting's utterances, runs the C++ rule extractor over them
 * and then the reconciler, inside one transaction. Comparable in cost to an index build today, but
 * measuring one of the two and re-tuning it must not silently re-tune the other.
 */
const ITEM_BATCH = 12;

/**
 * Meeting count at the end of the last COMPLETED search backfill, or -1 if one has never finished.
 *
 * Deliberately module-level rather than store state: it is control state for the sweep, and
 * putting it in the store would re-render every subscriber each time it changed. Comparing it
 * against the current count is what makes the sweep self-healing — a backup restore drops a pile
 * of un-indexed meetings into the database and moves the count, so the very next focus sweeps
 * again without anything having to know a restore happened.
 */
let searchSweptAtCount = -1;

/** Guards against two focus events overlapping their loops. */
let searchRunning = false;

/**
 * The SAME two, for the item migration, and separate on purpose — see [backfillItems].
 *
 * One shared latch would be set by whichever sweep drained first and would then short-circuit the
 * other's backlog until the meeting count moved, which on a library nobody is adding to is never.
 * One shared `running` flag would let a long search backfill — a restored 4,000-meeting backup —
 * stop the item sweep from ever starting on that focus. They are two different questions about
 * two different tables and neither answer can stand in for the other.
 */
let itemsSweptAtCount = -1;
let itemsRunning = false;

interface LibraryState {
  meetings: Meeting[];
  loading: boolean;
  /** Persisted: how somebody likes their library is a preference, not a per-visit decision. */
  sort: MeetingSort;
  /**
   * NOT persisted. A tag filter is a question being asked right now — "what did I agree with this
   * client" — and coming back tomorrow to a library that silently hides most of it, because of a
   * filter set once last week, reads as lost data.
   */
  tag: string | null;
  tags: { name: string; n: number }[];
  setSort: (sort: MeetingSort) => Promise<void>;
  setTag: (tag: string | null) => Promise<void>;
  /** Meetings still without search-index rows, as of the last pass. Surfaced by SearchScreen. */
  unindexed: number;
  /** True while the backfill loop is running, so search can say why it may be missing things. */
  indexing: boolean;
  refresh: () => Promise<void>;
  backfillSearch: () => Promise<void>;
  /** Resolves with whether native was actually asked; see the action for why that is the answer. */
  backfillItems: () => Promise<boolean>;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  meetings: [],
  loading: false,
  sort: 'recent',
  tag: null,
  tags: [],
  unindexed: 0,
  indexing: false,

  setSort: async (sort: MeetingSort) => {
    set({ sort });
    await db.setSetting('librarySort', sort).catch(() => {});
    await get().refresh();
  },

  setTag: async (tag: string | null) => {
    set({ tag });
    await get().refresh();
  },

  refresh: async () => {
    set({ loading: true });
    try {
      // The stored preference is read on every refresh rather than once at startup, so a sort
      // chosen on one screen is in force on the next without anything having to broadcast it.
      const stored = (await db.getSetting('librarySort').catch(() => null)) as MeetingSort | null;
      const sort = stored ?? get().sort;
      let tag = get().tag;
      const tags = await db.allTags().catch(() => []);
      // A tag whose last meeting was just deleted stops existing. Dropping the filter is the only
      // way back: the list would otherwise be empty with no way to see it was being filtered.
      if (tag && !tags.some(t => t.name === tag)) tag = null;
      const meetings = await db.listMeetings(sort, tag);
      set({ meetings, tags, tag, sort, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  /**
   * Index every meeting recorded before the search index covered anything but the transcript.
   *
   * Search claims to cover transcripts, minutes, titles and summaries. For a library that predates
   * that claim it covers none of them, because those rows were written before anything indexed
   * them — so the decision a person is hunting for is simply absent from the index until this has
   * run once.
   *
   * It runs off the render path, one small batch at a time, yielding to the event loop between
   * passes so a long backlog never blocks a scroll. Native reports how many meetings are still
   * outstanding, and the loop keeps going until that reaches zero.
   *
   * It does NOT run on every focus. Once a pass has drained the backlog the meeting count at that
   * moment is latched, and the sweep short-circuits until the count moves — a new recording, a
   * deletion, or a restored backup. Every one of those cases costs a single native call that
   * answers zero; only a genuine backlog costs more.
   */
  backfillSearch: async () => {
    if (searchRunning) return;
    const count = get().meetings.length;
    if (count === searchSweptAtCount) return;

    searchRunning = true;
    set({ indexing: true });
    try {
      let remaining = 0;
      let previous = Number.POSITIVE_INFINITY;
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        remaining = await db.backfillSearch(BATCH);
        set({ unindexed: Math.max(0, remaining) });
        if (remaining <= 0) break;
        // A pass that did not shrink the backlog will not shrink it next time either. Stopping
        // leaves the latch unset, so the next focus retries rather than looping here forever.
        if (remaining >= previous) break;
        previous = remaining;
        await new Promise<void>(resolve => setTimeout(resolve, 60));
      }
      if (remaining <= 0) searchSweptAtCount = count;
    } catch {
      // Left unlatched on purpose: an index that failed half way is exactly the case that should
      // be retried, and the only cost of retrying is one native call.
    } finally {
      searchRunning = false;
      set({ indexing: false });
    }
  },

  /**
   * Give every meeting recorded before items existed its items, and move its ticks onto them.
   *
   * WHY A SWEEP AT ALL, when Task 8 shipped a per-meeting migration and rejected this shape. The
   * lazy trigger is correct for the meeting screen and cannot serve the three CROSS-MEETING readers
   * of `items`: the worklist (ActionsScreen), the Library's outstanding-actions tally, and Search's
   * "meetings with actions" filter. Under lazy-only all three describe the meetings somebody has
   * opened since updating rather than the library — so a person with a fortnight of unticked work
   * is told they have none. That is not a visible gap, it is a confident false negative, and the
   * list it is stated on is the one this feature exists to make believable. `backfillSearch` above
   * is the precedent and the reason is identical: search is cross-meeting too, and lazy indexing
   * was not enough for it either.
   *
   * ONE of the three is on screen today, and the order is deliberate rather than lucky. Search's
   * filter is live and reachable. `ActionsScreen` is built and registered in RootNavigator, and
   * nothing navigates to it; LibraryScreen tallies actions into `work` on every focus and renders
   * none of it. Both are somebody's next task, and the data has to be there BEFORE the entry point
   * is — shipping the screen first is how a worklist gets its first impression made by a library
   * that has not been migrated yet.
   *
   * "Done" cannot be inferred from the items themselves, which is the one place this differs from
   * the search sweep. Every meeting with a transcript produces at least one index row, so
   * `unindexedMeetings` can ask whether the rows exist; a meeting whose transcript legitimately
   * yields no decisions, actions or questions produces ZERO items, forever, and would come back in
   * every batch for the rest of the install's life with the backlog never reaching zero. Native
   * stamps `meetings.items_migrated_at` instead — see AudioDb.backfillItems.
   *
   * The loop is `backfillSearch`'s, for `backfillSearch`'s reasons: off the render path, one small
   * batch at a time, yielding between passes so a long backlog never blocks a scroll; latched on
   * the meeting count once the backlog drains so an ordinary focus costs a single native call that
   * answers zero; stopping without latching whenever a pass fails to shrink the backlog or the
   * call rejects, because both are states that should be retried and neither is a reason to switch
   * the sweep off permanently.
   *
   * @return whether native was asked. LibraryScreen counts outstanding actions on focus, and on
   *   the first focus after an update it does that BEFORE this has migrated anything — so `true`
   *   means any cross-meeting count taken before now may be stale and is worth re-taking, and
   *   `false` means the latch short-circuited this and nothing on disk moved because of it.
   */
  backfillItems: async () => {
    if (itemsRunning) return false;
    const count = get().meetings.length;
    if (count === itemsSweptAtCount) return false;

    itemsRunning = true;
    try {
      let remaining = 0;
      let previous = Number.POSITIVE_INFINITY;
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        remaining = await db.backfillItems(ITEM_BATCH);
        if (remaining <= 0) break;
        // A pass that did not shrink the backlog will not shrink it next time either. Stopping
        // leaves the latch unset, so the next focus retries rather than looping here forever.
        if (remaining >= previous) break;
        previous = remaining;
        await new Promise<void>(resolve => setTimeout(resolve, 60));
      }
      if (remaining <= 0) itemsSweptAtCount = count;
    } catch {
      // Left unlatched on purpose: what rejects here is loading the native core on a phone still
      // downloading libonnxruntime.so, and a meeting reads fine unmigrated. The next focus retries.
    } finally {
      itemsRunning = false;
    }
    return true;
  },
}));
