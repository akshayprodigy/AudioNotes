/**
 * What the processing screen tells somebody who is waiting.
 *
 * Pulled out of MeetingScreen and made pure after a 90-minute meeting spent 78 minutes reporting
 * "1% · about 236 min left" with the spinner on stage one, while VAD and ASR had both finished.
 * Nothing was wrong with the pipeline. Everything was wrong with this arithmetic, and it was
 * convincing enough that a healthy run got killed for looking hung.
 *
 * Pure so the numbers can be tested without a device, which is the only way they get checked at
 * all — the failure only shows on a meeting long enough that nobody runs one by hand.
 */

export interface Stage {
  key: string;
  label: string;
  /** Seconds of work per second of audio, measured on a Pixel 7 Pro. */
  rate: number;
}

/**
 * Pipeline stages, phrased as what they achieve, priced by what this phone actually did.
 *
 * VAD and ASR were re-measured on 6 Sep against a 90-minute import: VAD 45.8 s and ASR 1854.6 s
 * for 5400 s of audio. The old constants said 0.08 and 1.47 — the ASR one was 4.3x pessimistic,
 * which is most of how a 30-minute transcription came to be advertised as four hours.
 *
 * Diarization's 0.67 is NOT measured and is left alone deliberately: the same run was still in
 * diarization after 47 minutes (0.52x and climbing) when it was stopped, so the true figure is a
 * lower bound at best. It is the next thing to measure, and probably the next thing to fix — see
 * docs/NEXT.md. Minutes and narration are likewise untouched, having no long-meeting measurement.
 */
export const STAGES: Stage[] = [
  { key: 'vad', label: 'Audio cleaned up', rate: 0.01 },
  { key: 'asr', label: 'Words written down', rate: 0.34 },
  { key: 'diarize', label: 'Speakers separated', rate: 0.67 },
  { key: 'minutes', label: 'Pulling out the minutes', rate: 0.11 },
  { key: 'narrate', label: 'Written up in plain English', rate: 0.32 },
  // bge-small over ~150 windows of a 60-minute meeting: seconds, not minutes. Pro only — a free
  // phone never reports this stage, and the ETA is one stage generous for it, which is the safe
  // direction.
  { key: 'embed', label: 'Indexed for meaning', rate: 0.01 },
];

/**
 * The stage that is RUNNING, given the last one that finished.
 *
 * `meetings.status` names the stage that completed, not the one in flight — ProcessingEngine
 * writes "vad" after VAD returns, "asr" after ASR returns. Reading it as the running stage is an
 * off-by-one that parks the display a whole stage behind, and the stage it parks on is the
 * cheapest one while the stage it hides is the longest.
 */
export function stageFromStatus(status: string | null | undefined): string {
  switch (status) {
    case 'vad':
      return 'asr';
    case 'asr':
      return 'diarize';
    case 'diarized':
      return 'minutes';
    default:
      // 'recording', 'captured', or anything unrecognised: nothing has run yet.
      return 'vad';
  }
}

export interface ProgressInput {
  /** The last stage an event reported, or null when none has arrived this mount. */
  liveStage: string | null;
  /** The meeting's persisted status, used when no event has arrived. */
  status: string | null | undefined;
  /** The recording's own length. Remaining work is priced from this, never from elapsed time. */
  audioSec: number;
  /**
   * Seconds of work per second of audio, as this phone has measured them (db.stageRates()).
   * A stage missing here falls back to the shipped constant, which is one Pixel's number.
   */
  rates?: Partial<Record<string, number>>;
  /**
   * How far the running stage is, 0..1, from its own counts (ASR windows, diarization chunks,
   * narrator steps). undefined when the stage has only said it started.
   */
  fraction?: number;
}

export interface Progress {
  index: number;
  pct: number;
  etaSec: number;
}

/** A stage's rate on this phone, or the shipped one. */
export function rateFor(stage: Stage, rates?: Partial<Record<string, number>>): number {
  const learned = rates?.[stage.key];
  return typeof learned === 'number' && Number.isFinite(learned) && learned > 0 ? learned : stage.rate;
}

/** A stage that reports only that it started is treated as 40% through. */
const RUNNING_GUESS = 0.4;

/**
 * Where we are and how much is left.
 *
 * A live event wins when there is one, because it is current. Without one — which is every time
 * somebody opens a meeting that is already processing — the persisted status is consulted rather
 * than assuming the first stage. Assuming was the bug: for a 90-minute meeting the next event was
 * half an hour away, so the screen claimed the first stage for half an hour.
 */
export function progressFor({ liveStage, status, audioSec, rates, fraction }: ProgressInput): Progress {
  const key = liveStage ?? stageFromStatus(status);
  const found = STAGES.findIndex(x => x.key === key);
  const index = found < 0 ? 0 : found;
  const through = typeof fraction === 'number' ? Math.min(1, Math.max(0, fraction)) : RUNNING_GUESS;

  const rate = (x: Stage) => rateFor(x, rates);
  const total = STAGES.reduce((a, x) => a + rate(x), 0);
  const doneRate = STAGES.slice(0, index).reduce((a, x) => a + rate(x), 0);
  const runningRate = rate(STAGES[index]);
  const pct = Math.min(99, Math.round(((doneRate + runningRate * through) / total) * 100));

  // Remaining work priced from the recording's own length rather than from elapsed time, which is
  // what made a transcript-only re-run promise a finish it was nowhere near.
  const remainingRate = STAGES.slice(index).reduce((a, x) => a + rate(x), 0) - runningRate * through;
  const etaSec = audioSec > 0 ? Math.max(1, Math.round(remainingRate * audioSec)) : 0;

  return { index, pct, etaSec };
}
