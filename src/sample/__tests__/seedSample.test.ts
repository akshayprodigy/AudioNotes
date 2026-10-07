import Storage from '../../native/NativeStorage';
import Player from '../../native/NativePlayer';
import AudioPipeline from '../../native/NativeAudioPipeline';
import Licence from '../../native/NativeLicence';
import Billing from '../../native/NativeBilling';
import bundle from '../sampleMeeting.json';
import { SAMPLE_ID } from '../sampleId';
import { deleteSample, seedSample } from '../seedSample';

/** The jest.setup.js Player stub has no installSample; the real one is native (PlayerModule). */
const installSample = jest.fn(async (id: string) => ({ path: `/files/meetings/${id}/audio.pcm`, durationMs: 64512 }));
(Player as any).installSample = installSample;

type Stmt = { sql: string; params: unknown[] };
const query = Storage.query as jest.Mock;
const transaction = Storage.transaction as jest.Mock;

/** What the database says when asked whether the sample is there. */
function sampleRows(n: number) {
  query.mockImplementation(async (sql: string) => (/COUNT\(\*\)/i.test(sql) ? JSON.stringify([{ n }]) : '[]'));
}
const written = (): Stmt[] => JSON.parse(transaction.mock.calls[0][0]);
const inserts = (into: string) => written().filter(s => new RegExp(`^INSERT INTO ${into}\\b`).test(s.sql));

beforeEach(() => {
  jest.clearAllMocks();
  sampleRows(0);
  (Player.hasAudio as jest.Mock).mockResolvedValue(true);
});

describe('seedSample', () => {
  it('writes the whole meeting in ONE transaction, as an ordinary finished meeting', async () => {
    await expect(seedSample()).resolves.toEqual({ created: true });
    expect(transaction).toHaveBeenCalledTimes(1);

    const [meeting] = inserts('meetings');
    expect(meeting.params[0]).toBe('sample-meeting-v1');
    expect(meeting.sql).toMatch(/'done'/); // status: every screen treats it as finished
    expect(meeting.params).toContain('/files/meetings/sample-meeting-v1/audio.pcm');
    expect(meeting.params).toContain(bundle.title);

    expect(inserts('utterances')).toHaveLength(bundle.utterances.length);
    expect(inserts('speakers').map(s => s.params[3])).toEqual(['Priya', 'Sam']);
    expect(inserts('minutes')).toHaveLength(bundle.minutes.length);
    expect(inserts('items')).toHaveLength(bundle.items.length);
    expect(inserts('item_sources')).toHaveLength(bundle.items.reduce((n, i) => n + i.sources.length, 0));
    // The one finished action is already ticked.
    expect(inserts('item_done')).toHaveLength(1);
  });

  it('makes the rows rule-written and migrated, so no sweep re-extracts them or re-times the items', async () => {
    await seedSample();
    for (const item of inserts('items')) expect(item.params).toContain('rules@1');
    expect(inserts('meetings')[0].sql).toMatch(/items_migrated_at/);
  });

  it('points every item source at an utterance that is actually inserted, with the same times', async () => {
    await seedSample();
    const utt = new Map(inserts('utterances').map(s => [s.params[0] as string, s.params]));
    for (const src of inserts('item_sources')) {
      const u = utt.get(src.params[6] as string);
      expect(u).toBeDefined();
      expect(u![2]).toBe(src.params[2]); // start_ms
      expect(u![3]).toBe(src.params[3]); // end_ms
    }
  });

  it('searches the sample like any other meeting, by reindexing it once written', async () => {
    await seedSample();
    expect(Storage.reindex).toHaveBeenCalledWith(SAMPLE_ID);
  });

  it('is idempotent: with the sample already there it writes nothing', async () => {
    sampleRows(1);
    await expect(seedSample()).resolves.toEqual({ created: false });
    expect(transaction).not.toHaveBeenCalled();
    expect(installSample).not.toHaveBeenCalled();
  });

  it('puts the audio back when it has gone (a swept or restored phone), and un-hides an archived sample', async () => {
    sampleRows(1);
    (Player.hasAudio as jest.Mock).mockResolvedValue(false);
    await seedSample();
    expect(installSample).toHaveBeenCalledWith(SAMPLE_ID);
    const sqls = query.mock.calls.map(c => c[0] as string);
    expect(sqls.some(q => /UPDATE meetings SET audio_path/.test(q))).toBe(true);
    expect(sqls.some(q => /archived_at = NULL/.test(q))).toBe(true);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('writes the audio before the row, so a meeting never exists without its recording', async () => {
    const order: string[] = [];
    installSample.mockImplementationOnce(async id => {
      order.push('audio');
      return { path: `/p/${id}`, durationMs: 1 };
    });
    transaction.mockImplementationOnce(async () => {
      order.push('rows');
    });
    await seedSample();
    expect(order).toEqual(['audio', 'rows']);
  });
});

describe('the sample never touches the allowance', () => {
  it('calls no licence or billing method, starts no capture, and writes no allowance row', async () => {
    await seedSample();
    await deleteSample();
    for (const name of Object.keys(Licence)) {
      const fn = (Licence as any)[name];
      if (jest.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
    }
    for (const name of Object.keys(Billing)) {
      const fn = (Billing as any)[name];
      if (jest.isMockFunction(fn)) expect(fn).not.toHaveBeenCalled();
    }
    expect(AudioPipeline.start).not.toHaveBeenCalled();
    const everySql = [...query.mock.calls.map(c => c[0] as string), ...written().map(s => s.sql)];
    expect(everySql.some(q => /allowance/i.test(q))).toBe(false);
  });
});

describe('deleteSample', () => {
  it('removes the audio and the meeting and nothing else, and does not fail if the audio is gone', async () => {
    (AudioPipeline.discardAudio as jest.Mock).mockRejectedValueOnce(new Error('gone'));
    await deleteSample();
    expect(AudioPipeline.discardAudio).toHaveBeenCalledWith(SAMPLE_ID);
    const sqls = query.mock.calls.map(c => [c[0], c[1]]);
    expect(sqls).toContainEqual(['DELETE FROM meetings WHERE id = ?', JSON.stringify([SAMPLE_ID])]);
  });
});
