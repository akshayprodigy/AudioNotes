import type { IconName } from '../components/Icon';

/**
 * The three lines the Pro screen shows above the fold — the whole pitch for somebody who reads
 * nothing else. Pure, so the choice is testable without rendering the screen.
 *
 * Meetings lead: the monthly limit is the thing a Free user actually runs into. The written
 * minutes come second, but only on a phone that can run the writer — on a phone under the
 * writer's gate the most visible promise on the page would be false, so search by meaning takes
 * its place. Somebody sent here by the export gate sees export first: that is what they tapped.
 */
export type Highlight = { key: 'meetings' | 'writer' | 'export' | 'meaning'; icon: IconName; text: string };

const MEETINGS: Highlight = { key: 'meetings', icon: 'inbox', text: 'Unlimited meetings, any length' };
const WRITER: Highlight = { key: 'writer', icon: 'edit', text: 'Minutes written for you, in sentences' };
const EXPORT: Highlight = { key: 'export', icon: 'share', text: 'Export to PDF, MP3, SRT and more' };
const MEANING: Highlight = { key: 'meaning', icon: 'search', text: 'Search by what was meant, not only said' };

export function proHighlights(from: 'onboarding' | 'export' | undefined, writerRuns: boolean): Highlight[] {
  const second = writerRuns ? WRITER : MEANING;
  return from === 'export' ? [EXPORT, MEETINGS, second] : [MEETINGS, second, EXPORT];
}
