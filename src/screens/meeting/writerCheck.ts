/**
 * F24: what the writer's fact check removed from this meeting's summary, as one quiet line.
 *
 * Narrator.kt writes `writer_check:<meetingId>` = "<n>|<class,class>" alongside the summary rows
 * (FactGuard.settingKey / Tally.encoded). It is a settings key and not a `minutes` row on purpose:
 * `minutes` rows are indexed for search, and a count has no business in a search hit.
 *
 * "0|" is what a clean narration writes, so a re-run clears a stale count. A missing key — a
 * meeting written before F24, or a rule-only one — reads as nothing removed, never as an error.
 */
export const writerCheckKey = (meetingId: string): string => `writer_check:${meetingId}`;

export function writerCheckLine(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const head = raw.split('|')[0];
  if (!/^\d+$/.test(head)) return null;
  const n = parseInt(head, 10);
  if (n <= 0) return null;
  return n === 1
    ? "1 sentence removed because the transcript doesn't support it."
    : `${n} sentences removed because the transcript doesn't support them.`;
}
