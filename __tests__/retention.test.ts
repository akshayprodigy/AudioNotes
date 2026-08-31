// Audio retention: which window applies, and who does the deleting.
//
// The window matters because the app changed its mind about it. The original setting was a
// boolean (`keepAudio`) whose "off" meant "delete the moment a transcript exists" — which is why
// nobody could play back a meeting to check what was actually said. The replacement is a window in
// days, and the two have to coexist: an install that predates the change has only the boolean, and
// somebody who deliberately turned it on must not have their audio deleted a week later because
// the app started reading a different key.
//
// The deleting itself is native on purpose. Recording from the Quick Settings tile or the PiP
// window never starts a JS context, so a JS-only sweep would quietly make the "kept for 7 days"
// promise false for the person who records for a month without opening the app.
import { db } from '../src/db/queries';
import AudioPipeline from '../src/native/NativeAudioPipeline';

jest.mock('../src/db/queries', () => ({
  db: {
    pendingMeetings: jest.fn(async () => []),
    getSetting: jest.fn(async () => null),
    backfillSearch: jest.fn(async () => 0),
  },
}));

// Imported after the mock so the controller closes over the mocked db.
import {
  DEFAULT_RETENTION_DAYS,
  PipelineController,
  resolveRetentionDays,
} from '../src/pipeline/PipelineController';

const mockDb = db as unknown as {
  pendingMeetings: jest.Mock;
  getSetting: jest.Mock;
  backfillSearch: jest.Mock;
};
const mockSweep = AudioPipeline.sweepAudioRetention as jest.Mock;
const mockRecover = AudioPipeline.recoverOrphans as jest.Mock;

/** Answer getSetting from a plain map, the way the settings table behaves (absent -> null). */
const settings = (values: Record<string, string>) =>
  mockDb.getSetting.mockImplementation(async (key: string) => values[key] ?? null);

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.pendingMeetings.mockResolvedValue([]);
  mockDb.backfillSearch.mockResolvedValue(0);
  mockRecover.mockResolvedValue(0);
  mockSweep.mockResolvedValue(0);
  settings({});
});

describe('resolveRetentionDays', () => {
  it('defaults to a week when nothing has ever been set', () => {
    expect(resolveRetentionDays(null, null)).toBe(DEFAULT_RETENTION_DAYS);
    expect(DEFAULT_RETENTION_DAYS).toBe(7);
  });

  it('honours the legacy keepAudio switch as "keep until I delete the meeting"', () => {
    // -1 is the sentinel for forever. Somebody who turned the old switch on did so precisely
    // because they wanted the audio kept, and must not lose it to the new default.
    expect(resolveRetentionDays(null, '1')).toBe(-1);
  });

  it('treats keepAudio off as the new default rather than the old delete-immediately', () => {
    // The old meaning of '0' was "discard as soon as a transcript exists". Carrying that forward
    // would keep playback broken for every existing install, which is the bug this replaces.
    expect(resolveRetentionDays(null, '0')).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('lets an explicit window win over the legacy switch, in both directions', () => {
    expect(resolveRetentionDays('30', '1')).toBe(30);
    expect(resolveRetentionDays('-1', '0')).toBe(-1);
    expect(resolveRetentionDays('0', '1')).toBe(0); // delete as soon as there is a transcript
  });

  it('falls back rather than deleting when the stored window is malformed', () => {
    // Number('') is 0 and Number('7 days') is NaN. Reading either as a window would mean
    // "delete everything now" — the one outcome a parsing accident must never produce.
    expect(resolveRetentionDays('', null)).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays('7 days', null)).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays('3.5', null)).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays('  ', '1')).toBe(-1);
  });
});

describe('PipelineController sweep() — retention', () => {
  it('asks native to sweep, rather than deleting anything itself', async () => {
    settings({ audioRetentionDays: '7' });

    await PipelineController.processPending();

    expect(mockSweep).toHaveBeenCalledTimes(1);
  });

  it('does not call native at all when the user keeps audio forever', async () => {
    settings({ keepAudio: '1' });

    await PipelineController.processPending();

    // Nothing is ever past a window that does not close, so the JNI hop is pointless. Native
    // resolves the same window itself and would sweep nothing even if it were called.
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('still processes pending meetings when the retention sweep fails', async () => {
    settings({});
    mockSweep.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(PipelineController.processPending()).resolves.toBeUndefined();

    // Cleanup is best-effort; a meeting waiting to be transcribed must not be held up by it.
    expect(mockDb.pendingMeetings).toHaveBeenCalled();
  });

  it('drains the search backfill on the same pass', async () => {
    await PipelineController.processPending();

    // Indexing a library of old meetings has to happen somewhere, and open() runs on the main
    // thread on a Quick Settings cold start — a batch per sweep is the seam that avoids a freeze.
    expect(mockDb.backfillSearch).toHaveBeenCalled();
  });
});
