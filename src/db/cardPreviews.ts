// What a Library card can say about a finished meeting when no writer wrote it a headline: its
// first decision, else its first action. One read for the whole library, so a card never costs a
// query of its own. Its own file, and not db/queries.ts, because it only reads.
import Storage from '../native/NativeStorage';
import { cardPreview } from '../screens/meeting/takeaway';

export type CardPreviewRow = { firstDecision: string | null; firstAction: string | null };

const FIRST = (kind: string) =>
  `(SELECT i.text FROM items i WHERE i.meeting_id = m.id AND i.kind = '${kind}' AND i.review <> 'rejected' ` +
  // Hand-typed rows carry a sentinel anchor, so they sort after everything said aloud.
  'ORDER BY i.anchor_start_ms, i.rowid LIMIT 1)';

export const CARD_PREVIEWS_SQL =
  `SELECT m.id AS meetingId, ${FIRST('decision')} AS firstDecision, ${FIRST('action')} AS firstAction ` +
  "FROM meetings m WHERE m.archived_at IS NULL AND m.status = 'done'";

/** Meeting id to its preview source. A meeting with no items is simply absent. */
export async function cardPreviews(): Promise<Map<string, CardPreviewRow>> {
  const rows = JSON.parse(await Storage.query(CARD_PREVIEWS_SQL, '[]')) as (CardPreviewRow & {
    meetingId: string;
  })[];
  const out = new Map<string, CardPreviewRow>();
  for (const r of rows) {
    if (r.firstDecision || r.firstAction) {
      out.set(r.meetingId, { firstDecision: r.firstDecision ?? null, firstAction: r.firstAction ?? null });
    }
  }
  return out;
}

/**
 * The listed meetings with a one-line preview in `summaryLine` where the writer wrote none.
 *
 * A finished meeting only: an in-flight one's line is its processing state, and a failed one's is
 * its reason. A headline the writer did write is never replaced.
 */
export function withPreviews<M extends { id: string; status: string; summaryLine?: string | null }>(
  meetings: M[],
  previews: Map<string, CardPreviewRow>,
): M[] {
  return meetings.map(m => {
    if (m.status !== 'done' || (m.summaryLine && m.summaryLine.trim())) return m;
    const p = previews.get(m.id);
    const line = p ? cardPreview({ summaryLine: null, ...p }) : null;
    return line ? { ...m, summaryLine: line } : m;
  });
}
