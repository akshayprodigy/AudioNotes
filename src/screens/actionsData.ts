import { db } from '../db/queries';
import type { ActionRow } from '../pipeline/types';

/**
 * Loading the cross-meeting worklist.
 *
 * The two halves are still fetched separately and joined here, but for a far smaller reason than
 * before: it used to be IMPOSSIBLE in SQL, because a tick was keyed on a hash of the item's TEXT
 * that SQLite could not reproduce. An id-keyed tick is one LEFT JOIN away, and the only thing
 * keeping it out of the query is that `allActions` has a second caller — SearchScreen's "meetings
 * with actions" filter — which wants those rows and not their ticks. The hash is gone from this
 * path entirely, which is the change that matters.
 *
 * Both callers (ActionsScreen and the library's counts) therefore see only the meetings the item
 * migration has reached — see db.allActions, which is where that is written down in full.
 *
 * WHICH TICK STORE THIS IS. `item_done`, keyed on item ids. The meeting's own Actions tab still
 * reads and writes `action_done`, keyed on hashed text, until Task 10 moves it — so between this
 * build and that one, an item ticked here is not ticked there, and the reverse. Ticks made before
 * this build are in both, because Task 8's migration wrote both.
 */

/** The full worklist, newest meeting first, with each item's tick resolved. */
export async function loadActions(): Promise<ActionRow[]> {
  const [rows, done] = await Promise.all([db.allActions(), db.doneItemIds()]);
  // The separator matches db.doneItemIds exactly: a NUL, which cannot occur in either half.
  return rows.map(r => ({ ...r, done: done.has(`${r.meetingId}\u0000${r.id}`) }));
}

/**
 * Counts for the library's entry point.
 *
 * `meetings` counts only the meetings with something still outstanding, because that is the
 * sentence the card wants to say — "9 outstanding across 3 meetings" — and counting every meeting
 * that ever produced an action would make the number grow while the work shrank.
 */
export function tally(rows: ActionRow[]): { total: number; open: number; meetings: number } {
  const open = rows.filter(r => !r.done);
  return {
    total: rows.length,
    open: open.length,
    meetings: new Set(open.map(r => r.meetingId)).size,
  };
}
