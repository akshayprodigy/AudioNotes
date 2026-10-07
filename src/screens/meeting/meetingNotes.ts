/**
 * The sentences a meeting says about itself that are not its content: how the recording ended,
 * whether the room was told, and — when nothing is written yet — which of four very different
 * situations this is. Pure, so they are tested without rendering a screen.
 */

const ENDED: Record<string, string> = {
  cap_reached: 'Stopped at the Free limit',
  mic_lost: 'Stopped early: a call or another app took the microphone',
  disk_full: 'Stopped early: the phone ran out of space',
  write_failed: 'Stopped early: the audio could not be saved',
  mic_unavailable: 'The microphone could not be opened',
  pause_timeout: 'Ended after an hour paused',
};

/** Null for a Stop, and for meetings recorded before the reason was kept. */
export function endingNote(reason: string | null | undefined, durationMs: number): string | null {
  const why = reason ? ENDED[reason] : undefined;
  if (!why) return null;
  return durationMs > 0 ? `${why}. Everything up to that point is kept.` : `${why}, so nothing was recorded.`;
}

/** How long after a meeting ended its explanation may still be offered on the Record screen. */
export const ENDING_CARD_DAYS = 7;

/** The settings key that records "the person has seen why this meeting ended early". */
export const endingAckKey = (meetingId: string) => `ending_ack.${meetingId}`;

/**
 * The sentence the Record screen shows, once, for the newest meeting when it ended for a reason
 * other than the person's own Stop. Null when there is nothing to say: a Stop, a meeting recorded
 * before the reason was kept, one already acknowledged, one older than a week, or the Free-limit
 * ending on a phone that is Pro now (the limit no longer applies, so the sentence would mislead).
 */
export function endingCardNote(
  m: { createdAt: number; durationMs: number; endReason?: string | null } | null | undefined,
  opts: { acknowledged: boolean; paid: boolean; now: number },
): string | null {
  if (!m || opts.acknowledged) return null;
  if (opts.now - m.createdAt > ENDING_CARD_DAYS * 24 * 60 * 60 * 1000) return null;
  if (m.endReason === 'cap_reached' && opts.paid) return null;
  return endingNote(m.endReason, m.durationMs);
}

/** AnnouncementPlayer's outcome as one line. Null when the meeting predates the outcome being kept. */
export function announceLine(outcome: string | null | undefined): { text: string; warn: boolean } | null {
  switch (outcome) {
    case 'played':
      return { text: 'Announced at the start of the recording.', warn: false };
    case 'silenced':
      return { text: 'Not announced: the phone was on silent.', warn: true };
    case 'not_heard':
      return { text: 'Not announced: the recording did not pick the announcement up.', warn: true };
    case 'disabled':
      return { text: 'Not announced: the announcement is switched off.', warn: true };
    case 'failed':
    case 'no_clip':
      return { text: 'Not announced: the announcement did not play.', warn: true };
    default:
      return null;
  }
}

export type Hold = 'waiting' | 'failed' | 'no-speech' | 'no-audio';

const PENDING = ['recording', 'captured', 'vad', 'asr', 'diarized'];

/**
 * What a meeting with nothing written is. Only 'no-speech' may say "could not hear any speech":
 * a queued meeting, one waiting for its model, and a crash all used to.
 */
export function holdFor(m: { status: string; durationMs: number } | null | undefined): Hold {
  if (!m || PENDING.includes(m.status)) return 'waiting';
  if (m.status === 'failed') return 'failed';
  return m.durationMs > 0 ? 'no-speech' : 'no-audio';
}
