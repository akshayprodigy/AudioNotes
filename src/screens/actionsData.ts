import { db } from '../db/queries';
import type { ActionRow } from '../pipeline/types';

/**
 * Loading the cross-meeting worklist.
 *
 * The two halves are still fetched separately and joined here, but for a far smaller reason than
 * before: it used to be IMPOSSIBLE in SQL, because a tick was keyed on a hash of the item's TEXT
 * that SQLite could not reproduce. An id-keyed tick is one LEFT JOIN away, so what keeping it out
 * actually buys was worked out rather than assumed. The join would delete `doneItemIds` and the
 * flattened key below. It would NOT delete this map: SQLite has no boolean, so
 * `d.item_id IS NOT NULL AS done` comes back through AudioDb.rawQueryJson as 0 or 1
 * (FIELD_TYPE_INTEGER -> getLong), and something here still has to walk every row to keep
 * `ActionRow.done` a boolean rather than a number that reads as true. What is left is two queries
 * answering two questions — what actions exist, what is ticked — against one query answering both
 * for a second caller (SearchScreen's "meetings with actions" filter) that wants only the first.
 * A small win either way; the change that matters is that the hash is gone from this path
 * entirely.
 *
 * Both callers (ActionsScreen and the library's counts) therefore see only the meetings the item
 * migration has reached — see db.allActions, which is where that is written down in full.
 *
 * WHICH TICK STORE THIS IS. `item_done`, keyed on item ids — and since Task 10 the meeting's own
 * Actions tab writes the same store with the same key, so a tick made in either place is the same
 * tick. Between Task 9 and Task 10 it was not: that tab read `action_done`, keyed on hashed text,
 * and the two screens held separate answers for one item. The gap was accepted, recorded, and is
 * closed.
 *
 * What `action_done` still holds, and why this list cannot see it: the rows with no item id to key
 * on, which since Task 12 is one population and not two — every row of a meeting the item
 * migration has not reached. None of them is in `items`, so none is in `allActions` either, and
 * this list is consistent with itself rather than half-informed. A row somebody TYPED was the
 * second such population, and it is in `items` now, tick and all.
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
