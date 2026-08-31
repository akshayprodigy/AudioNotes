// PipelineController.sweep() must route every pending meeting through process() -> the native
// ProcessingService. Native now owns the full pipeline including the rule-based minutes floor,
// retitling, and retention — its status-aware completion gate resumes only the missing stages for
// a meeting whose rows already exist (e.g. utterances + speakers present but status isn't 'done'
// yet), so sweep() no longer needs a JS-side "finish it locally" shortcut. See Task 6 / feat/headless-mom.
import { db } from '../src/db/queries';
import AudioPipeline from '../src/native/NativeAudioPipeline';
import type { Meeting, Utterance, Speaker } from '../src/pipeline/types';

jest.mock('../src/db/queries', () => ({
  db: {
    pendingMeetings: jest.fn(),
    utterances: jest.fn(),
    speakers: jest.fn(),
    segments: jest.fn(async () => []),
    minutes: jest.fn(async () => []),
    replaceMinutes: jest.fn(async () => {}),
    setStatus: jest.fn(async () => {}),
    getMeeting: jest.fn(async () => undefined),
    setTitle: jest.fn(async () => {}),
    // db.getSetting's real return type infers as Promise<string> (see queries.ts), so use ''
    // rather than null here — it still fails the 'keepAudio' === '1' check the same way.
    getSetting: jest.fn(async () => ''),
  },
}));

// Imported after the mock so PipelineController picks up the mocked db.
import { PipelineController } from '../src/pipeline/PipelineController';

// NativeLlm's default export resolves to the jest.setup.js mock (available/capable/load default
// to false), so importing it here gives us the same jest.fn()s to assert against.
import Llm from '../src/native/NativeLlm';
const mockLlm = Llm as unknown as {
  available: jest.Mock; capable: jest.Mock; load: jest.Mock; generate: jest.Mock; unload: jest.Mock;
};

const mockDb = db as jest.Mocked<typeof db>;
const mockProcess = AudioPipeline.process as jest.Mock;

const utt = (id: string, meetingId: string): Utterance => ({
  id,
  meetingId,
  startMs: 0,
  endMs: 1000,
  speakerId: 's1',
  text: 'hello there',
});

const speaker = (meetingId: string): Speaker => ({
  id: 's1',
  meetingId,
  clusterLabel: 'A',
  displayName: 'Speaker A',
});

const meeting = (id: string): Meeting => ({
  id,
  title: 'Meeting',
  createdAt: Date.now(),
  durationMs: 60000,
  language: 'en',
  status: 'diarized',
  tierUsed: 'free',
  audioRetained: 1,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.segments.mockResolvedValue([]);
  mockDb.replaceMinutes.mockResolvedValue(undefined as any);
  mockDb.setStatus.mockResolvedValue(undefined as any);
  mockDb.getMeeting.mockResolvedValue(undefined as any);
  mockDb.setTitle.mockResolvedValue(undefined as any);
  mockDb.getSetting.mockResolvedValue('');
  mockDb.minutes.mockResolvedValue([]);
});

describe('PipelineController sweep()', () => {
  // Note: both cases below reject AudioPipeline.process so the run resolves deterministically —
  // the jest-wide NativeEventEmitter mock (jest.setup.js) is a genuine no-op, so there is no way
  // to fake a native 'onStageComplete' event from a test. The reject path still proves what
  // matters here: sweep() calls AudioPipeline.process (via process()) and never writes minutes
  // itself, regardless of outcome.
  it('no longer shortcuts a meeting that already has utterances + speakers — routes it through process() -> AudioPipeline.process instead of a direct db write', async () => {
    mockDb.pendingMeetings.mockResolvedValue([{ id: 'm1' }]);
    mockDb.utterances.mockResolvedValue([utt('u1', 'm1')]);
    mockDb.speakers.mockResolvedValue([speaker('m1')]);
    mockDb.getMeeting.mockResolvedValue(meeting('m1'));
    mockProcess.mockRejectedValueOnce(new Error('boom'));

    await expect(PipelineController.processPending()).resolves.toBeUndefined();

    // This meeting has utterances AND speakers — under the old behavior sweep() would have
    // finished it locally via buildMinutes and never called AudioPipeline.process at all.
    expect(mockProcess).toHaveBeenCalledWith('m1', { model: 'base' });
    expect(mockDb.replaceMinutes).not.toHaveBeenCalled();
  });

  it('routes a meeting with utterances but no speakers to process(), and resolves (not throws) when AudioPipeline.process rejects', async () => {
    mockDb.pendingMeetings.mockResolvedValue([{ id: 'm2' }]);
    mockDb.utterances.mockResolvedValue([utt('u1', 'm2')]);
    mockDb.speakers.mockResolvedValue([]); // diarization hasn't produced speakers yet
    mockProcess.mockRejectedValueOnce(new Error('boom'));

    // awaitNativeComplete's kick().catch() resolves 'error' instead of letting the rejection
    // propagate, so process() — and therefore the whole sweep — must resolve normally.
    await expect(PipelineController.processPending()).resolves.toBeUndefined();

    expect(mockProcess).toHaveBeenCalledWith('m2', { model: 'base' });
    // outcome 'error' short-circuits process() before minutes are ever touched.
    expect(mockDb.replaceMinutes).not.toHaveBeenCalled();
  });
});

describe('PipelineController buildMinutes() — on-demand rebuild (SpeakersScreen "regenerate" after merge)', () => {
  it('marks a meeting NO SPEECH (error) when ASR ran (status asr) but produced zero utterances', async () => {
    // VAD found speech spans, but whisper transcribed them all to blanks (0 utterances). The engine
    // set status 'asr' (it only does so when the ASR model was present), so ASR genuinely ran and
    // re-running it yields the same nothing — this must be terminal, not left pending to re-transcribe
    // on every Library sweep forever.
    mockDb.utterances.mockResolvedValue([]);
    mockDb.segments.mockResolvedValue([0, 1000] as any); // spans exist
    mockDb.getMeeting.mockResolvedValue({ ...meeting('m3'), status: 'asr' });

    await PipelineController.buildMinutes('m3');

    expect(mockDb.setStatus).toHaveBeenCalledWith('m3', 'error');
    expect(mockDb.replaceMinutes).not.toHaveBeenCalled();
  });

  it('leaves a meeting pending (no status change) when spans exist but ASR has not run yet (status vad)', async () => {
    // Spans but no utterances AND status still 'vad' means the whisper model has not run — typically
    // still downloading. Marking it terminal would strand a recoverable meeting, so it must stay
    // pending for the next sweep.
    mockDb.utterances.mockResolvedValue([]);
    mockDb.segments.mockResolvedValue([0, 1000] as any);
    mockDb.getMeeting.mockResolvedValue({ ...meeting('m4'), status: 'vad' });

    await PipelineController.buildMinutes('m4');

    expect(mockDb.setStatus).not.toHaveBeenCalled();
    expect(mockDb.replaceMinutes).not.toHaveBeenCalled();
  });

  it('marks a truly silent meeting (no spans, no utterances) NO SPEECH (error), unchanged behavior', async () => {
    mockDb.utterances.mockResolvedValue([]);
    mockDb.segments.mockResolvedValue([] as any); // no speech spans at all

    await PipelineController.buildMinutes('m5');

    expect(mockDb.setStatus).toHaveBeenCalledWith('m5', 'error');
  });
});

describe('PipelineController regenerateMinutes() — rule rebuild after a speaker merge', () => {
  // This used to have to be "tier-preserving": buildMinutes deleted every minutes row, so a
  // speaker merge silently threw away the summary and the narrative, and regenerateMinutes had to
  // detect that and re-run the LLM to put them back. Two things removed the need. replaceMinutes
  // is scoped to source='rule', so rewriting the items cannot touch the prose; and narration is a
  // native pipeline stage now, so JS has no LLM path to re-run even if it wanted one.

  it('rebuilds the rule minutes without reaching for the LLM, even when the meeting has prose', async () => {
    mockDb.minutes.mockResolvedValue([
      { id: 'm6:llm:0', meetingId: 'm6', kind: 'summary', content: 'x', source: 'llm' },
    ]);
    mockDb.utterances.mockResolvedValue([utt('u1', 'm6')]);
    mockDb.speakers.mockResolvedValue([speaker('m6')]);

    await PipelineController.regenerateMinutes('m6');

    expect(mockDb.replaceMinutes).toHaveBeenCalled();
    // Every row handed to replaceMinutes is a rule row. The prose is not JS's to rewrite.
    for (const [, rows] of mockDb.replaceMinutes.mock.calls) {
      for (const row of rows) expect(row.source).toBe('rule');
    }
    expect(mockLlm.available).not.toHaveBeenCalled();
  });

  it('rebuilds the rule minutes for a meeting that has never been narrated', async () => {
    mockDb.minutes.mockResolvedValue([
      { id: 'm7:rule:0', meetingId: 'm7', kind: 'summary', content: 'x', source: 'rule' },
    ]);
    mockDb.utterances.mockResolvedValue([utt('u1', 'm7')]);
    mockDb.speakers.mockResolvedValue([speaker('m7')]);

    await PipelineController.regenerateMinutes('m7');

    expect(mockDb.replaceMinutes).toHaveBeenCalled();
    expect(mockLlm.available).not.toHaveBeenCalled();
  });
});

describe('PipelineController process() — the force flag', () => {
  // "Write it again" used to delete the existing prose so the resume plan would find work to do.
  // A rewrite that then could not run — entitlement lapsed, model uninstalled, the process killed
  // for memory — destroyed the summary it was meant to replace. `force` marks narration
  // outstanding without deleting anything, so the old prose stands until new prose overwrites it.
  it('passes force straight through to native', async () => {
    mockProcess.mockRejectedValueOnce(new Error('boom'));

    await PipelineController.process('m8', { model: 'small', force: true });

    expect(mockProcess).toHaveBeenCalledWith('m8', { model: 'small', force: true });
  });

  it('leaves the flag off when nobody asked for a rewrite', async () => {
    mockProcess.mockRejectedValueOnce(new Error('boom'));

    await PipelineController.process('m9', { model: 'base' });

    expect(mockProcess).toHaveBeenCalledWith('m9', { model: 'base' });
  });
});
