// The auto-retitle guard.
//
// The pipeline replaces a placeholder title with the opening of the transcript, because a library
// of rows all reading "Meeting" is unusable. The danger is the other direction: this runs on EVERY
// pass over a meeting that is not yet 'done', not only on an explicit reprocess, so a guard that
// gets it wrong does not merely fail once — it overwrites the user's own words again and again.
//
// Until the `title_edited_at` column existed the guard was a string sniff, and the sniff cannot
// tell the app's placeholder from a real title that happens to look like one. "Tuesday standup
// meeting · notes" is an ordinary thing to type and the old code clobbered it.
import { db } from '../src/db/queries';
import Storage from '../src/native/NativeStorage';
import type { Utterance } from '../src/pipeline/types';

jest.mock('../src/db/queries', () => ({
  db: {
    utterances: jest.fn(async () => []),
    speakers: jest.fn(async () => []),
    segments: jest.fn(async () => []),
    minutes: jest.fn(async () => []),
    replaceMinutes: jest.fn(async () => {}),
    setStatus: jest.fn(async () => {}),
    setTitle: jest.fn(async () => {}),
    getMeeting: jest.fn(async () => undefined),
    getSetting: jest.fn(async () => null),
    pendingMeetings: jest.fn(async () => []),
    backfillSearch: jest.fn(async () => 0),
  },
}));

// Imported after the mock so the controller closes over the mocked db.
import {
  PipelineController,
  shouldAutoRetitle,
  stripOpeningFiller,
} from '../src/pipeline/PipelineController';

const mockDb = db as unknown as Record<string, jest.Mock>;
const mockQuery = Storage.query as unknown as jest.Mock;

const utt = (text: string): Utterance => ({
  id: 'u1',
  meetingId: 'm1',
  startMs: 0,
  endMs: 5000,
  speakerId: 's1',
  text,
});

/** What the raw title read in retitleFromTranscript returns for this meeting. */
const meetingRow = (title: string, titleEditedAt: number | null) =>
  mockQuery.mockResolvedValue(JSON.stringify([{ title, titleEditedAt }]));

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.utterances.mockResolvedValue([utt('Okay so the rollout plan is what we need to settle.')]);
  mockDb.speakers.mockResolvedValue([]);
  mockDb.segments.mockResolvedValue([]);
  mockDb.replaceMinutes.mockResolvedValue(undefined);
  mockDb.setStatus.mockResolvedValue(undefined);
  mockDb.setTitle.mockResolvedValue(undefined);
});

describe('shouldAutoRetitle', () => {
  it('accepts the two titles the app writes for itself', () => {
    expect(shouldAutoRetitle('Meeting', null)).toBe(true);
    expect(shouldAutoRetitle('Mon 30 Aug meeting · 14:05', null)).toBe(true);
  });

  it('leaves an ordinary title alone', () => {
    expect(shouldAutoRetitle('Pricing call with Acme', null)).toBe(false);
  });

  it('never overwrites a title a person set, even one the string sniff would have taken', () => {
    // The regression this guard exists for: the sniff matches " meeting · " anywhere in the
    // string, so a perfectly deliberate title used to be replaced by the first line of the
    // transcript — on every pass, so renaming it back did not even hold.
    expect(shouldAutoRetitle('Tuesday standup meeting · notes', 1756500000000)).toBe(false);
    expect(shouldAutoRetitle('Meeting', 1756500000000)).toBe(false);
  });

  it('still improves a placeholder on a meeting recorded before the stamp existed', () => {
    // Rows from before the column was added have no stamp at all. Treating a missing stamp as
    // "renamed" would freeze every one of those libraries on "Meeting" forever.
    expect(shouldAutoRetitle('Meeting', 0)).toBe(true);
    expect(shouldAutoRetitle('Meeting', undefined)).toBe(true);
  });
});

describe('PipelineController.buildMinutes — retitling', () => {
  it('writes a title over the placeholder, without the opening filler', async () => {
    meetingRow('Meeting', null);

    await PipelineController.buildMinutes('m1');

    // The transcript opens "Okay so the rollout plan is what we need to settle". Both leading
    // words are dropped and the result recapitalised — this expectation used to include them,
    // and updating it is the point of the change rather than a casualty of it.
    expect(mockDb.setTitle).toHaveBeenCalledWith(
      'm1',
      'The rollout plan is what we need to settle',
    );
  });

  it('leaves a renamed meeting alone even when its title looks generated', async () => {
    meetingRow('Tuesday standup meeting · notes', 1756500000000);

    await PipelineController.buildMinutes('m1');

    expect(mockDb.setTitle).not.toHaveBeenCalled();
    // The rest of the pass is unaffected — minutes are still rebuilt and the meeting finishes.
    expect(mockDb.replaceMinutes).toHaveBeenCalled();
    expect(mockDb.setStatus).toHaveBeenCalledWith('m1', 'done');
  });

  it('reads the stamp as a number even when SQLite hands it back as text', async () => {
    // Every bound parameter reaches SQLite as TEXT and JSON round-trips are not guaranteed to
    // preserve the column's type, so a stamp arriving as "1756500000000" must still count.
    meetingRow('Meeting', '1756500000000' as unknown as number);

    await PipelineController.buildMinutes('m1');

    expect(mockDb.setTitle).not.toHaveBeenCalled();
  });

  it('does not touch the title when the meeting row cannot be read', async () => {
    // Deleted under us, or the read failed. Not retitling is cosmetic; overwriting a title we
    // could not check is not.
    mockQuery.mockResolvedValue('[]');

    await PipelineController.buildMinutes('m1');

    expect(mockDb.setTitle).not.toHaveBeenCalled();
  });
});

describe('stripOpeningFiller', () => {
  // The exact title this produced off a real recording, where the leading "So" was the only word
  // a reader had to skip. Mirrored by ProcessingEngine.stripOpeningFiller for the headless path.
  it('drops the throat-clearing a meeting opens with', () => {
    expect(stripOpeningFiller('So there are three different stages to the design')).toBe(
      'there are three different stages to the design',
    );
    expect(stripOpeningFiller('Okay so um yeah let us start with the budget review')).toBe(
      'let us start with the budget review',
    );
    expect(stripOpeningFiller('Right, so the pricing question from last week')).toBe(
      'the pricing question from last week',
    );
  });

  it('leaves a title that opens with something meaningful alone', () => {
    const real = 'Pricing for the enterprise tier needs a decision today';
    expect(stripOpeningFiller(real)).toBe(real);
  });

  it('never strips a meeting down to nothing', () => {
    // The floor. Without it these lose their name entirely, which is worse than a filler word.
    expect(stripOpeningFiller('So, right')).toBe('So, right');
    expect(stripOpeningFiller('Okay then')).toBe('Okay then');
    expect(stripOpeningFiller('')).toBe('');
  });

  it('only strips whole words', () => {
    // "Nowhere" and "Sofa" begin with filler spellings and are not filler.
    const a = 'Nowhere in the contract does it say that';
    const b = 'Sofa delivery is blocked on the warehouse';
    expect(stripOpeningFiller(a)).toBe(a);
    expect(stripOpeningFiller(b)).toBe(b);
  });
});
