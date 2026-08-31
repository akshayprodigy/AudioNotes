import { db } from '../db/queries';
import { itemKey } from './meeting/ActionsTab';
import type { ActionRow } from '../pipeline/types';

/**
 * Loading the cross-meeting worklist.
 *
 * Lives outside both screens that need it because the tick state cannot be resolved in SQL. A tick
 * is keyed on a hash of the item's normalised TEXT (see ActionsTab.itemKey) rather than on the
 * minutes row id — those rows are deleted and re-inserted whenever a meeting is reprocessed or its
 * speakers are merged, so a row-id key would silently uncheck everything a person had worked
 * through. SQLite cannot reproduce that hash, so `allActions` and `doneKeys` come back separately
 * and are joined here.
 *
 * The hash is IMPORTED, never reimplemented. A second copy that drifted by one character would not
 * fail loudly; it would quietly render every ticked item as outstanding, which is the one thing
 * this list must never do.
 */

/** The full worklist, newest meeting first, with each item's tick resolved. */
export async function loadActions(): Promise<ActionRow[]> {
  const [rows, done] = await Promise.all([db.allActions(), db.doneKeys()]);
  return rows.map(r => {
    const key = itemKey(r.content);
    // The separator matches db.doneKeys exactly: a NUL, which cannot occur in either half.
    return { ...r, itemKey: key, done: done.has(`${r.meetingId}\u0000${key}`) };
  });
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
