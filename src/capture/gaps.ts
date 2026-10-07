/**
 * Call interruptions on a recording (F26). The Android recorder notes the stretches where the
 * system silenced the microphone (a phone call, the privacy toggle, another app) and stores them
 * once, at the end of the capture, as `[[startMs,endMs],…]` under the settings key
 * `capture_gaps:<meetingId>` — the captured-audio clock, pauses excluded, so the numbers line up
 * with the file. Nothing is stored for a recording with none.
 *
 * This is the reading side, pure: parse, merge, drop anything under two seconds, clamp to the
 * recording's length, and word the one sentence a person reads. The Kotlin twin is
 * `GapPolicy.kt`; both pin the same examples, so a change to the rule is a change in both tests.
 * Android 10+ only on the recorder's side; an older phone simply has no key.
 */

export type Gap = [number, number];

/** Shorter than this is a flicker, not a call. */
export const MIN_GAP_MS = 2_000;

export const gapsKey = (meetingId: string): string => `capture_gaps:${meetingId}`;

/** Missing, malformed or odd entries are no gaps — never a throw. */
export function parseGaps(raw: string | null | undefined): Gap[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: Gap[] = [];
  for (const pair of v) {
    if (Array.isArray(pair) && pair.length >= 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1])) {
      out.push([Number(pair[0]), Number(pair[1])]);
    }
  }
  return out;
}

/** Merged (overlapping or touching), clamped to [0, recordingMs], nothing under MIN_GAP_MS, sorted. */
export function normaliseGaps(gaps: Gap[], recordingMs: number): Gap[] {
  const clamped: Gap[] = [];
  for (const [a, b] of gaps) {
    const s = Math.max(0, Math.min(a, b));
    const e = Math.min(Math.max(a, b), recordingMs);
    if (e > s) clamped.push([s, e]);
  }
  clamped.sort((x, y) => x[0] - y[0]);
  const merged: Gap[] = [];
  for (const [s, e] of clamped) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.filter(([s, e]) => e - s >= MIN_GAP_MS);
}

export function totalSilencedMs(gaps: Gap[], recordingMs: number): number {
  return normaliseGaps(gaps, recordingMs).reduce((n, [s, e]) => n + (e - s), 0);
}

/**
 * The sentence for `silencedMs` in total, or null under a second. Under a minute it counts
 * seconds ("1 second", "45 seconds"); from a minute it rounds to whole minutes ("4 min").
 */
export function gapSentence(silencedMs: number): string | null {
  if (!(silencedMs >= 1_000)) return null;
  const seconds = Math.floor(silencedMs / 1_000);
  const amount =
    seconds < 60 ? (seconds === 1 ? '1 second' : `${seconds} seconds`) : `${Math.floor((seconds + 30) / 60)} min`;
  return `Your phone's microphone was silenced for ${amount} (a call, or another app) — that part wasn't recorded.`;
}

/** The note for a meeting, or null when nothing was silenced for long enough to mention. */
export function captureGapNote(raw: string | null | undefined, recordingMs: number): string | null {
  return gapSentence(totalSilencedMs(parseGaps(raw), recordingMs));
}

/** Reads the stored key through `getSetting` (`db.getSetting`) and words it. Never throws. */
export async function loadCaptureGapNote(
  meetingId: string,
  recordingMs: number,
  getSetting: (key: string) => Promise<string | null>,
): Promise<string | null> {
  try {
    return captureGapNote(await getSetting(gapsKey(meetingId)), recordingMs);
  } catch {
    return null;
  }
}
