import type { ThreadResult } from '../pipeline/types';

/** The one line a tagged meeting's Summary tab shows under its summary card (Phase 3). */
export function threadLine(tag: string, open: number, decisions: number): string {
  return `${tag}: ${open} open · ${decisions} ${decisions === 1 ? 'decision' : 'decisions'}`;
}

/**
 * A thread's open/decision counts, with this meeting's OWN rows excluded — the line says what is
 * *earlier*, not what this meeting itself just produced. Null on a refusal, and null when nothing
 * is left once this meeting is taken out: a tag on only one meeting is not a thread yet.
 */
export function countsExcluding(
  meetingId: string,
  thread: ThreadResult,
): { open: number; decisions: number } | null {
  if ('refusal' in thread) return null;
  if (!thread.meetings.some(m => m.id !== meetingId)) return null;
  return {
    open: thread.open.filter(r => r.meetingId !== meetingId).length,
    decisions: thread.decisions.filter(r => r.meetingId !== meetingId).length,
  };
}
