/**
 * Phase 5: what the Record screen offers before the first word — a meeting of several people, or
 * one person dictating a note. The choice is remembered (`record_mode`) and stamped on the meeting
 * at creation; everything downstream (no diarization, spoken marks, the note as the write-up) reads
 * `meetings.mode`, never this setting.
 */
export type RecordMode = 'meeting' | 'dictation';

export const RECORD_MODE_KEY = 'record_mode';

export const RECORD_MODES: { key: RecordMode; label: string }[] = [
  { key: 'meeting', label: 'Meeting' },
  { key: 'dictation', label: 'Dictation' },
];

/** The stored value, or `meeting` for anything else — a blank, an old build's typo, null. */
export function recordModeOf(stored: string | null | undefined): RecordMode {
  return stored === 'dictation' ? 'dictation' : 'meeting';
}

export function modeLabel(mode: RecordMode): string {
  return mode === 'dictation' ? 'Dictation' : 'Meeting';
}

/** The standing line under the clock while idle. `capMs > 0` is the free tier's limit. */
export function idleHint(mode: RecordMode, capMs: number): string {
  const verb = mode === 'dictation' ? 'Tap to dictate' : 'Tap to start recording';
  return capMs > 0 ? `${verb} · up to 15 min on Free` : verb;
}

/** Shown under the mode switch in dictation only: the marks are spoken, and this is the list. */
export const DICTATION_TIP =
  'Say “full stop”, “comma”, “question mark”, “new line” and “new paragraph” — they become the marks.';
