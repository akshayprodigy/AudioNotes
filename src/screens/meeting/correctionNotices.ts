/**
 * What the Meeting screen says about transcript corrections (F15). The decisions are made natively
 * (android .../data/Corrections.kt); the keys and the sentences are spelled here and there, and
 * `correctionNotices.test.ts` / `CorrectionsTest.kt` name each other for the same reason
 * `ItemKey` does: a drifted key is a notice that never shows, with no error anywhere.
 */

/** Native sets it when a correction changes a line of a meeting with a written summary. */
export const staleKey = (meetingId: string) => `narration.stale.${meetingId}`;
/** Native adds to it when a re-transcription could not place corrections; read once, then cleared. */
export const droppedKey = (meetingId: string) => `corrections.dropped.${meetingId}`;

export const STALE_SUMMARY_COPY =
  'You corrected the transcript after this summary was written. Write it again to update it.';

export function droppedNotice(count: number): string | null {
  if (!(count > 0)) return null;
  return count === 1
    ? "1 correction couldn't be re-applied"
    : `${count} corrections couldn't be re-applied`;
}

type Settings = {
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<unknown>;
};

/** The sentence to show for corrections a re-transcription dropped — once: reading it clears it. */
export async function takeDroppedNotice(db: Settings, meetingId: string): Promise<string | null> {
  const raw = await db.getSetting(droppedKey(meetingId));
  const n = Number.parseInt(raw ?? '', 10);
  if (!(n > 0)) return null;
  await db.setSetting(droppedKey(meetingId), '0');
  return droppedNotice(n);
}
