/**
 * Free beside Pro, for the sheet the Library's count opens. Every row is a claim the app keeps on
 * THIS phone: the transcriber row only where whisper-small runs, the written-minutes row and Ask
 * only where the writer runs. Pure.
 */
export type CompareRow = {
  key: 'meetings' | 'length' | 'transcript' | 'minutes' | 'search' | 'export';
  label: string;
  free: string;
  pro: string;
};

export function planCompare(writerRuns: boolean, smallRuns: boolean): CompareRow[] {
  const rows: CompareRow[] = [
    { key: 'meetings', label: 'Meetings', free: '5 a month', pro: 'Unlimited' },
    { key: 'length', label: 'Length', free: 'Up to 1 hour', pro: 'Any length' },
  ];
  if (smallRuns) rows.push({ key: 'transcript', label: 'Transcript', free: 'Standard', pro: 'More accurate' });
  if (writerRuns) rows.push({ key: 'minutes', label: 'Minutes', free: 'Pulled out by rule', pro: 'Written in sentences' });
  rows.push({ key: 'search', label: 'Search', free: 'By keyword', pro: writerRuns ? 'By meaning, and Ask' : 'By meaning' });
  rows.push({ key: 'export', label: 'Export', free: 'Copy the notes', pro: 'PDF, MP3, SRT and more' });
  return rows;
}
