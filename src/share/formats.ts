/**
 * The document formats a meeting can be shared in. Sharing any file is a Pro feature, decided and
 * enforced natively (ExportGate.kt); the Share screen only reacts to the refusal.
 */
export type ShareFormat = 'pdf' | 'md' | 'txt' | 'srt';

export const SHARE_FORMATS: { key: ShareFormat; label: string; hint: string }[] = [
  { key: 'pdf', label: 'PDF', hint: 'The one that looks the same wherever it lands.' },
  { key: 'md', label: 'Markdown', hint: 'For notes apps and wikis.' },
  { key: 'txt', label: 'Text', hint: 'For anything else.' },
  { key: 'srt', label: 'Subtitles', hint: 'The transcript, timed, for a video editor.' },
];

/**
 * The original recording, as an MP3. Not a document, so it has no preview and no credit line, and it
 * is offered only while the audio is still on the phone.
 */
export const MP3 = 'mp3' as const;
export type ShareChoice = ShareFormat | typeof MP3;

export const MP3_LABEL = 'MP3 (original recording)';
export const MP3_HINT = 'The recording itself, not the minutes. About 28 MB an hour.';

/** Shown, verbatim, when there is no recording to send. Mirrors Mp3Export.DELETED_MESSAGE in Kotlin. */
export const AUDIO_DELETED_MESSAGE = 'The recording for this meeting was deleted, so there is nothing to export.';

/** A subtitle track is played over video; a line at the end saying where it came from is an advert. */
export const carriesAttribution = (f: ShareChoice) => f !== 'srt' && f !== MP3;
