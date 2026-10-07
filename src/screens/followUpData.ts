import { db } from '../db/queries';
import type { ActionRow, DecisionRow, ReviewItemRow } from '../pipeline/types';
import { isSampleId } from '../sample/sampleId';
import { loadActions } from './actionsData';
import { sentenceCase, splitAction } from './meeting/shared';

/**
 * The follow-up home's three questions, as pure functions over rows already read.
 *
 * Nothing in here reads the clock or the database: `today` is passed in, so "overdue" is a fact
 * about two numbers a test can write down. The loader at the bottom is the only part that touches
 * the outside world, and it hands the pure part the same rows the Actions screen shows.
 *
 * What is counted, and what deliberately is not:
 *  - Archived meetings never reach here (the SQL excludes them) and the bundled sample is taken
 *    out below, by the same prefix rule every other count uses.
 *  - A due date is the evidence layer's `date_norm` or it is nothing. "before Wednesday" does not
 *    resolve (DateNorm leaves it null on purpose), so it is not overdue and is not shown in a
 *    "no date" bucket either: guessing a day for it is the one thing this list must not do.
 */

/**
 * Decision statuses that still need somebody's attention.
 *
 *  - `open`       stands, nothing has touched it.
 *  - `qualified`  a later turn attached a condition ("if legal agrees"): not settled either.
 *
 * `contradicted` and `withdrawn` are settled in the sense that matters here: the decision is not
 * live any more, so listing it as "still open" would send people to chase something that ended.
 * A decision the classifier has not read (`status` null, which is every decision on Free and any
 * a person typed) is NOT counted: the record says nothing, and saying "open" would be a guess.
 */
export const UNRESOLVED_DECISION_STATUSES: readonly string[] = ['open', 'qualified'];

/**
 * A moment as the shape `date_norm` is stored in: the phone's calendar day as UTC midnight (see
 * ReviewScreen.meetingDayUtc, DateNorm). Pure given `nowMs` — the clock is read by the caller.
 */
export function dayStart(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Open actions whose resolved due day is `today` or earlier, most overdue first.
 * `today` is a `dayStart()` value.
 */
export function dueActions(rows: readonly ActionRow[], today: number): ActionRow[] {
  return rows
    .filter(
      r =>
        !r.done &&
        !isSampleId(r.meetingId) &&
        r.dateNorm !== null &&
        r.dateNorm !== undefined &&
        r.dateNorm <= today,
    )
    .sort((a, b) => (a.dateNorm as number) - (b.dateNorm as number) || b.createdAt - a.createdAt);
}

/** Decisions that are `open` or `qualified`, newest meeting first (the order they were fetched in). */
export function openDecisions(rows: readonly DecisionRow[]): DecisionRow[] {
  return rows.filter(
    r => !isSampleId(r.meetingId) && r.status !== null && UNRESOLVED_DECISION_STATUSES.includes(r.status),
  );
}

/** A meeting with something in its review queue. */
export interface ReviewMeeting {
  meetingId: string;
  meetingTitle: string;
  createdAt: number;
  count: number;
  /** The first waiting item's text, for the preview line. */
  firstText: string;
}

/** Group the queue's items by meeting, in the order the first of each arrived (newest meeting first). */
export function reviewMeetings(rows: readonly ReviewItemRow[]): ReviewMeeting[] {
  const out = new Map<string, ReviewMeeting>();
  for (const r of rows) {
    if (isSampleId(r.meetingId)) continue;
    const m = out.get(r.meetingId);
    if (m) m.count += 1;
    else
      out.set(r.meetingId, {
        meetingId: r.meetingId,
        meetingTitle: r.meetingTitle,
        createdAt: r.createdAt,
        count: 1,
        firstText: r.content,
      });
  }
  return [...out.values()];
}

/** The one line a row previews: the item's sentence without its "— Owner (due …)" tail. */
export function previewOf(content: string): string {
  return sentenceCase(splitAction(content).text);
}

export interface FollowUp {
  due: ActionRow[];
  decisions: DecisionRow[];
  review: ReviewMeeting[];
}

export function buildFollowUp(
  actions: readonly ActionRow[],
  decisions: readonly DecisionRow[],
  reviewItems: readonly ReviewItemRow[],
  today: number,
): FollowUp {
  return {
    due: dueActions(actions, today),
    decisions: openDecisions(decisions),
    review: reviewMeetings(reviewItems),
  };
}

export const emptyFollowUp: FollowUp = { due: [], decisions: [], review: [] };

/**
 * Read all three halves. The worklist is the Actions screen's own loader (owners resolved to
 * current names, ticks joined from `item_done`), so a row here is the row there. The two new
 * queries are allowed to fail on their own: a read that cannot be made costs its row, not the card.
 */
export async function loadFollowUp(
  nowMs: number = Date.now(),
  actions?: ActionRow[],
): Promise<FollowUp> {
  const [acts, decs, rev] = await Promise.all([
    actions ? Promise.resolve(actions) : loadActions(),
    Promise.resolve()
      .then(() => db.allDecisions())
      .catch(() => [] as DecisionRow[]),
    Promise.resolve()
      .then(() => db.reviewItems())
      .catch(() => [] as ReviewItemRow[]),
  ]);
  return buildFollowUp(acts, decs ?? [], rev ?? [], dayStart(nowMs));
}
