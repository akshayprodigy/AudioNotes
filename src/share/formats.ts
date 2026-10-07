/** The formats a meeting can be shared in. All of them are free, for everyone, always. */
export type ShareFormat = 'pdf' | 'md' | 'txt' | 'srt';

export const SHARE_FORMATS: { key: ShareFormat; label: string; hint: string }[] = [
  { key: 'pdf', label: 'PDF', hint: 'The one that looks the same wherever it lands.' },
  { key: 'md', label: 'Markdown', hint: 'For notes apps and wikis.' },
  { key: 'txt', label: 'Text', hint: 'For anything else.' },
  { key: 'srt', label: 'Subtitles', hint: 'The transcript, timed, for a video editor.' },
];

/** A subtitle track is played over video; a line at the end saying where it came from is an advert. */
export const carriesAttribution = (f: ShareFormat) => f !== 'srt';
