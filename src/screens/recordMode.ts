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
  return capMs > 0 ? `${verb} · up to 1 hour on Free` : verb;
}

/** Shown under the mode switch in dictation only: the marks are spoken, and this is the list. */
export const DICTATION_TIP =
  'Say “full stop”, “comma”, “question mark”, “new line” and “new paragraph” — they become the marks.';

/**
 * How long the spoken "this meeting is being recorded" clip occupies the start of a meeting: about
 * 5.7 s of clip after a ~0.3 s lag. The transcriber leaves that window out, so words said inside it
 * are kept in the audio but missing from the transcript (Nothing A069, 8 Oct) - hence the hint.
 */
export const ANNOUNCE_WINDOW_MS = 6500;

/** The standing line under the clock while recording. */
export function recordingHint(o: {
  paused: boolean;
  mode: RecordMode;
  announceOn: boolean;
  elapsedMs: number;
}): string {
  if (o.paused) return 'Paused — tap resume to continue';
  if (o.mode === 'meeting' && o.announceOn && o.elapsedMs < ANNOUNCE_WINDOW_MS) {
    return 'Announcing the recording — start speaking after it';
  }
  return 'Listening — tap to finish';
}
