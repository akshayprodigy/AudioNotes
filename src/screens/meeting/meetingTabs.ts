/**
 * The meeting screen's tabs, in reading order, and the words the person sees for each.
 *
 * Order is what people reach for: what was this about, then the written minutes, then the record
 * itself, then the worklist. Actions is last because it is the one you go to deliberately.
 *
 * THE KEYS ARE NOT THE LABELS. `mom` is a route-param value (Search, Ask, the Summary strip and a
 * notification can all open a meeting on it), so it keeps its spelling; only the label a person
 * reads changed, from "MOM" to "Minutes" and from "Script" to "Transcript". `tabKey` also takes the
 * new spelling, so a link written as `minutes` opens the same tab.
 */
export type MeetingTabKey = 'summary' | 'mom' | 'transcript' | 'actions';

export const MEETING_TABS: { key: MeetingTabKey; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'mom', label: 'Minutes' },
  { key: 'transcript', label: 'Transcript' },
  { key: 'actions', label: 'Actions' },
];

const ALIASES: Record<string, MeetingTabKey> = { minutes: 'mom' };

/** A route's tab value as a tab key: the old keys as they are, the new words as aliases. */
export function tabKey(value: string | undefined | null): string {
  if (!value) return 'summary';
  return ALIASES[value] ?? value;
}
