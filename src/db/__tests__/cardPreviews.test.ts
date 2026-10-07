import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../schema';

let mockSqlite: DatabaseSync;
jest.mock('../../native/NativeStorage', () => ({
  __esModule: true,
  default: {
    query: jest.fn(async (sql: string, params: string) =>
      JSON.stringify(mockSqlite.prepare(sql).all(...(JSON.parse(params) as any[]))),
    ),
  },
}));

import { cardPreviews } from '../cardPreviews';

const ddlFor = (name: string) =>
  SCHEMA.find(s => s.trimStart().startsWith(`CREATE TABLE IF NOT EXISTS ${name} (`))!;

const meeting = (id: string, status = 'done', archived: number | null = null) =>
  mockSqlite
    .prepare('INSERT INTO meetings(id, title, created_at, duration_ms, status, archived_at) VALUES(?,?,?,?,?,?)')
    .run(id, id, 1, 0, status, archived);
const item = (id: string, m: string, kind: string, text: string, anchor: number, review = 'suggested') =>
  mockSqlite
    .prepare(
      'INSERT INTO items(id, meeting_id, kind, text, review, gen_version, anchor_start_ms, anchor_end_ms, created_at) ' +
        "VALUES(?,?,?,?,?,'rules@1',?,?,0)",
    )
    .run(id, m, kind, text, review, anchor, anchor + 1);

beforeEach(() => {
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON;');
  mockSqlite.exec(ddlFor('meetings'));
  mockSqlite.exec(ddlFor('items'));
});

describe('cardPreviews', () => {
  it('is the earliest decision and the earliest action of each finished meeting', async () => {
    meeting('m1');
    item('d2', 'm1', 'decision', 'Second decision', 9000);
    item('d1', 'm1', 'decision', 'First decision', 1000);
    item('a1', 'm1', 'action', 'First action — Sam', 2000);
    const p = await cardPreviews();
    expect(p.get('m1')).toEqual({ firstDecision: 'First decision', firstAction: 'First action — Sam' });
  });

  it('skips a rejected item, an archived meeting and a meeting that is not done', async () => {
    meeting('m1');
    item('d1', 'm1', 'decision', 'Rejected one', 1000, 'rejected');
    item('d2', 'm1', 'decision', 'Kept one', 2000);
    meeting('m2', 'asr');
    item('d3', 'm2', 'decision', 'Still processing', 1000);
    meeting('m3', 'done', 5);
    item('d4', 'm3', 'decision', 'Archived', 1000);
    const p = await cardPreviews();
    expect(p.get('m1')?.firstDecision).toBe('Kept one');
    expect(p.has('m2')).toBe(false);
    expect(p.has('m3')).toBe(false);
  });

  it('leaves out a meeting with no items', async () => {
    meeting('m1');
    expect((await cardPreviews()).size).toBe(0);
  });
});

import { withPreviews } from '../cardPreviews';

describe('withPreviews', () => {
  const previews = new Map([['m1', { firstDecision: 'we will ship friday.', firstAction: null }]]);
  const done = (over: Record<string, unknown> = {}) => ({ id: 'm1', status: 'done', summaryLine: null, ...over });

  it('puts the first decision on a finished meeting that has no headline', () => {
    expect(withPreviews([done()], previews)[0].summaryLine).toBe('Decided: We will ship friday.');
  });
  it('never replaces a headline the writer wrote', () => {
    expect(withPreviews([done({ summaryLine: 'About the launch.' })], previews)[0].summaryLine).toBe('About the launch.');
  });
  it('leaves a meeting that is still being processed alone', () => {
    expect(withPreviews([done({ status: 'asr' })], previews)[0].summaryLine).toBeNull();
  });
  it('leaves a meeting with nothing to preview alone', () => {
    expect(withPreviews([done({ id: 'other' })], previews)[0].summaryLine).toBeNull();
  });
});
