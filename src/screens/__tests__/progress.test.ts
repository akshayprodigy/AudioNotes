import { STAGES, progressFor, stageFromStatus } from '../progress';

const NINETY_MIN = 90 * 60;

/**
 * What the processing screen tells somebody who is waiting.
 *
 * Written after a 90-minute meeting spent 78 minutes showing "1% · about 236 min left" with the
 * spinner on stage one — while VAD and ASR had both finished. The pipeline was working the whole
 * time and nothing on screen could have said so; it read as a hang convincingly enough that we
 * killed a healthy run.
 */
describe('which stage is actually running', () => {
  /**
   * The status column names the last stage that FINISHED, so the running stage is the next one.
   * Reading it as the running stage is the off-by-one that caused the whole problem.
   */
  it('reads the running stage from the last completed one', () => {
    expect(stageFromStatus('vad')).toBe('asr');
    expect(stageFromStatus('asr')).toBe('diarize');
    expect(stageFromStatus('diarized')).toBe('minutes');
  });

  it('starts at the beginning for a meeting that has not been processed yet', () => {
    expect(stageFromStatus('captured')).toBe('vad');
    expect(stageFromStatus('recording')).toBe('vad');
    expect(stageFromStatus(null)).toBe('vad');
    expect(stageFromStatus(undefined)).toBe('vad');
  });

  it('does not invent a stage for a status it does not know', () => {
    expect(stageFromStatus('something-new')).toBe('vad');
  });
});

describe('what the screen shows while it waits', () => {
  it('believes a live event over the stored status', () => {
    // An event is current; the status is only as fresh as the last stage boundary.
    const p = progressFor({ liveStage: 'diarize', status: 'vad', audioSec: NINETY_MIN });
    expect(STAGES[p.index].key).toBe('diarize');
  });

  it('falls back to the stored status when no event has arrived yet', () => {
    // Opening a meeting mid-run: this is the case that was broken.
    const p = progressFor({ liveStage: null, status: 'asr', audioSec: NINETY_MIN });
    expect(STAGES[p.index].key).toBe('diarize');
    expect(STAGES[p.index].label).toBe('Speakers separated');
  });

  it('no longer claims a 90-minute meeting needs four hours', () => {
    // The measured figure it replaces: 236 minutes, from constants and the wrong stage.
    const p = progressFor({ liveStage: 'asr', status: 'vad', audioSec: NINETY_MIN });
    expect(p.etaSec / 60).toBeLessThan(150);
  });

  it('moves off 1% once real work is done', () => {
    const early = progressFor({ liveStage: 'vad', status: 'captured', audioSec: NINETY_MIN });
    const later = progressFor({ liveStage: 'diarize', status: 'asr', audioSec: NINETY_MIN });
    expect(later.pct).toBeGreaterThan(early.pct);
    expect(later.pct).toBeGreaterThan(20);
  });

  it('never reports a finished-looking percentage while work remains', () => {
    for (const s of STAGES) {
      const p = progressFor({ liveStage: s.key, status: null, audioSec: NINETY_MIN });
      expect(p.pct).toBeGreaterThanOrEqual(0);
      expect(p.pct).toBeLessThan(100);
    }
  });

  it('gives no estimate when the recording length is unknown', () => {
    // Better to say nothing than to invent a number, which is how 236 min happened.
    expect(progressFor({ liveStage: 'asr', status: null, audioSec: 0 }).etaSec).toBe(0);
  });

  it('prices ASR from what this phone actually did, not a guess', () => {
    // 1854.6s of ASR for 5400s of audio, measured on a Pixel 7 Pro, 6 Sep 2026.
    const asr = STAGES.find(s => s.key === 'asr')!;
    expect(asr.rate).toBeCloseTo(0.34, 2);
  });
});
