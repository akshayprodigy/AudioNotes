// PipelineController.sweep() must not spin up the foreground service (AudioPipeline.process)
// for a meeting whose native stages already finished in the background — that only wastes a
// notification + service start for work that is already done. It should finish such meetings
// with the JS-only minutes floor instead. See Task 6 / feat/background-processing.
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
  it('finishes a pending meeting that already has utterances + speakers via buildMinutes, without calling AudioPipeline.process', async () => {
    mockDb.pendingMeetings.mockResolvedValue([{ id: 'm1' }]);
    mockDb.utterances.mockResolvedValue([utt('u1', 'm1')]);
    mockDb.speakers.mockResolvedValue([speaker('m1')]);
    mockDb.getMeeting.mockResolvedValue(meeting('m1'));

    await PipelineController.processPending();

    expect(mockProcess).not.toHaveBeenCalled();
    // buildMinutes ran: it wrote minutes from the transcript and marked the meeting done.
    expect(mockDb.replaceMinutes).toHaveBeenCalledWith('m1', expect.any(Array));
    expect(mockDb.setStatus).toHaveBeenCalledWith('m1', 'done');
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
    // outcome 'error' short-circuits process() before minutes are ever built.
    expect(mockDb.replaceMinutes).not.toHaveBeenCalled();
  });
});
