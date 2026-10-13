/**
 * How long a free recording may run.
 *
 * The free tier gives away the whole pipeline — record, transcribe, tell the speakers apart,
 * rule-based minutes, copy — because somebody has to see it work before they will pay for more
 * of it. What it does not give away is LENGTH, and length is the right lever for this product:
 * real meetings run sixty to ninety minutes, so a long one reaches the cap while a trial of the
 * app does not. (The month's five-session allowance is native too: AllowancePolicy.)
 *
 * Two rules this file exists to keep:
 *
 *   1. NOTHING IS EVER DESTROYED. Reaching the cap stops the recording; it does not discard it.
 *      The audio captured is saved and transcribed in full. An app that throws away somebody's
 *      meeting to enforce a price is an app they uninstall with a review attached.
 *   2. NOBODY IS SURPRISED. The limit is on the record screen before the first tap, and the
 *      warning arrives with five minutes left — enough to buy Pro and keep going, which
 *      is the point. Discovering a limit at the moment it takes your meeting is the failure this
 *      whole design is arranged around.
 *
 * The cap is enforced in RecordingService, not here. This module decides POLICY; a recording runs
 * in a foreground service with the screen off and the app killed, which is the normal case, and a
 * limit that only exists in JavaScript would not survive it.
 */

/** An hour — about one recurring meeting, so a real meeting fits and a trial of the app never nears it. */
export const FREE_CAP_MS = 60 * 60 * 1000;

/** Five minutes of notice: time to read it, decide, and buy Pro without breaking stride. */
export const WARN_BEFORE_MS = 5 * 60 * 1000;

/** No cap at all, for a subscriber or somebody inside their trial. */
export const NO_CAP = 0;

/**
 * The cap for an entitlement, in milliseconds. 0 means uncapped.
 *
 * A trial lifts it exactly as a subscription does — which is what makes the offer at minute fifty-five
 * work: one tap, no account, no payment, and the recording carries on rather than restarting.
 */
export function capMsFor(paid: boolean): number {
  return paid ? NO_CAP : FREE_CAP_MS;
}

export type CapPhase = 'uncapped' | 'running' | 'warning' | 'reached';

/** Where a recording stands against its cap. */
export function capPhase(elapsedMs: number, capMs: number): CapPhase {
  if (capMs <= 0) return 'uncapped';
  if (elapsedMs >= capMs) return 'reached';
  if (elapsedMs >= capMs - WARN_BEFORE_MS) return 'warning';
  return 'running';
}

/** Whole seconds left, floored at zero. Seconds, not minutes: the last minute counts down. */
export function secondsLeft(elapsedMs: number, capMs: number): number {
  if (capMs <= 0) return 0;
  return Math.max(0, Math.ceil((capMs - elapsedMs) / 1000));
}

/** "2:59" — the countdown as it is read out on the record screen. */
export function countdown(elapsedMs: number, capMs: number): string {
  const total = secondsLeft(elapsedMs, capMs);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
