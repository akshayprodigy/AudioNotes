import { create } from 'zustand';
import { db } from '../db/queries';
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
 * Meeting count at the end of the last COMPLETED backfill, or -1 if one has never finished.
 *
 * Deliberately module-level rather than store state: it is control state for the sweep, and
 * putting it in the store would re-render every subscriber each time it changed. Comparing it
 * against the current count is what makes the sweep self-healing — a backup restore drops a pile
 * of un-indexed meetings into the database and moves the count, so the very next focus sweeps
 * again without anything having to know a restore happened.
 */
let sweptAtCount = -1;

/** Guards against two focus events overlapping their loops. */
let running = false;

interface LibraryState {
  meetings: Meeting[];
  loading: boolean;
  /** Meetings still without search-index rows, as of the last pass. Surfaced by SearchScreen. */
  unindexed: number;
  /** True while the backfill loop is running, so search can say why it may be missing things. */
  indexing: boolean;
  refresh: () => Promise<void>;
  backfillSearch: () => Promise<void>;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  meetings: [],
  loading: false,
  unindexed: 0,
  indexing: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const meetings = await db.listMeetings();
      set({ meetings, loading: false });
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
    if (running) return;
    const count = get().meetings.length;
    if (count === sweptAtCount) return;

    running = true;
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
      if (remaining <= 0) sweptAtCount = count;
    } catch {
      // Left unlatched on purpose: an index that failed half way is exactly the case that should
      // be retried, and the only cost of retrying is one native call.
    } finally {
      running = false;
      set({ indexing: false });
    }
  },
}));
