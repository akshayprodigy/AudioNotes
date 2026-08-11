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
    expect(mockProcess).toHaveBeenCalledWith('m1', { model: 'base', useLLM: true });
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

    expect(mockProcess).toHaveBeenCalledWith('m2', { model: 'base', useLLM: true });
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
