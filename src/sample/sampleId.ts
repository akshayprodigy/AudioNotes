/**
 * Which meeting is the bundled sample, and the one rule for keeping it out of every count.
 *
 * The sample is an ordinary meeting row with a fixed id, so no schema carries it and every screen
 * works on it unmodified. What marks it is the id prefix, and this file is the only place that
 * says so: the Library's badge, its header, its Pro nudge, the audio sweep on the native side
 * (AudioRetention.SAMPLE_PREFIX) and the Pro offer on the meeting screen all ask here.
 *
 * Real meeting ids are UUIDs and cannot start with this.
 */
export const SAMPLE_PREFIX = 'sample-';
export const SAMPLE_ID = 'sample-meeting-v1';

export function isSampleId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(SAMPLE_PREFIX);
}

/**
 * The meetings that are the person's own. Every number the app states about how much they have
 * recorded - the Library's "N saved", minutes captured, the capture streak, the count that decides
 * when to offer Pro - is taken over this, never over the raw list. The Free allowance does not
 * need it: that is a ledger native writes when a recording or import STARTS, and the sample never
 * starts one.
 */
export function withoutSample<T extends { id: string }>(meetings: readonly T[]): T[] {
  return meetings.filter(m => !isSampleId(m.id));
}

/** One line over the top of the sample meeting; the Library says the same thing in a badge. */
export const sampleBannerText =
  "This is a sample so you can see the notes before recording. It isn't from your phone's microphone.";
