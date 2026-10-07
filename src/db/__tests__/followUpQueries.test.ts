import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../schema';

/**
 * The follow-up home's queries (decisions, the review queue, and the date_norm on the worklist),
 * run as SQL against a real SQLite
 * database rather than asserted as strings.
 *
 * A query layer tested with a mocked result set proves only that the mock was written to match
 * the assertion. These run the actual statements from `queries.ts` through `node:sqlite`, so the
 * column aliases, the join, the `kind` filter, the archived exclusion and the ordering are all
 * exercised by the same code the app ships — and a rewritten SELECT that quietly drops the
 * archived exclusion fails here instead of resurfacing a hidden meeting's work in the worklist.
 *
 * Same caveat as schema.test.ts, for the same reason: `src/db/schema.ts` is the READABLE copy of
 * the DDL and `AudioDb.SCHEMA` is the one that runs, so a column added on one side only would let
 * these tests pass against a database the phone does not have. Only the tables these queries
 * touch are created, because node:sqlite has no fts5 module and `meetings_fts` would take the
 * whole file down with it.
 */
let mockSqlite: DatabaseSync;

jest.mock('../../native/NativeStorage', () => ({
  __esModule: true,
  default: {
    // The whole typed layer goes through `query`, so this is the only method these tests need.
    query: jest.fn(async (sql: string, params: string) => {
      const args = JSON.parse(params) as any[];
      const stmt = mockSqlite.prepare(sql);
      if (/^\s*SELECT/i.test(sql)) return JSON.stringify(stmt.all(...args));
      stmt.run(...args);
      return '[]';
    }),
    reindex: jest.fn(async () => {}),
  },
}));

// Imported after the mock so the module under test binds to the SQLite-backed stand-in.
import { db } from '../queries';

function ddlFor(name: string): string {
  const stmt = SCHEMA.find(
    s =>
      s.trimStart().startsWith(`CREATE TABLE IF NOT EXISTS ${name} (`) ||
      s.includes(`CREATE INDEX IF NOT EXISTS ${name} `),
  );
  if (!stmt) throw new Error(`no DDL for ${name} in SCHEMA`);
  return stmt;
}

function meeting(id: string, title: string, createdAt: number, archivedAt: number | null = null) {
  mockSqlite
    .prepare(
      'INSERT INTO meetings(id, title, created_at, duration_ms, status, archived_at) ' +
        "VALUES(?,?,?,0,'done',?)",
    )
    .run(id, title, createdAt, archivedAt);
}

function item(
  id: string,
  meetingId: string,
  kind: string,
  text: string,
  anchorStartMs = 0,
  genVersion = 'rules@1',
  review = 'suggested',
  rec: { itemType?: string | null; status?: string | null; dateNorm?: number | null } = {},
) {
  mockSqlite
    .prepare(
      'INSERT INTO items(id, meeting_id, kind, text, review, gen_version, anchor_start_ms, ' +
        'anchor_end_ms, created_at, item_type, status, date_norm) VALUES(?,?,?,?,?,?,?,?,0,?,?,?)',
    )
    .run(
      id, meetingId, kind, text, review, genVersion, anchorStartMs, anchorStartMs + 1000,
      rec.itemType ?? null, rec.status ?? null, rec.dateNorm ?? null,
    );
}

beforeEach(() => {
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON;');
  for (const t of ['meetings', 'items', 'idx_items_meeting']) {
    mockSqlite.exec(ddlFor(t));
  }
});

afterEach(() => mockSqlite.close());

describe('allActions carries the evidence layer\'s due day', () => {
  it('returns date_norm, and null where the phrase was not pinned', async () => {
    meeting('m1', 'Standup', 1000);
    item('pinned', 'm1', 'action', 'Send it', 1, 'rules@1', 'suggested', { dateNorm: 1_790_000_000_000 });
    item('phrase', 'm1', 'action', 'Book it before Wednesday', 2);
    const rows = await db.allActions();
    expect(rows.map(r => [r.id, r.dateNorm])).toEqual([
      ['pinned', 1_790_000_000_000],
      ['phrase', null],
    ]);
  });
});

describe('allDecisions', () => {
  it('returns decisions with their status, newest meeting first, and no actions', async () => {
    meeting('m1', 'Standup', 1000);
    meeting('m2', 'Client call', 2000);
    item('d1', 'm1', 'decision', 'Use the agency', 5000, 'rules@1', 'suggested', { itemType: 'agreement', status: 'open' });
    item('d2', 'm2', 'decision', 'Ship Thursday', 3000, 'rules@1', 'suggested', { itemType: 'agreement', status: 'qualified' });
    item('a1', 'm2', 'action', 'Send it');
    const rows = await db.allDecisions();
    expect(rows.map(r => [r.id, r.status])).toEqual([['d2', 'qualified'], ['d1', 'open']]);
    expect(rows[0]).toMatchObject({ meetingTitle: 'Client call', anchorStartMs: 3000 });
  });

  it('excludes an archived meeting and a rejected decision', async () => {
    meeting('m1', 'Standup', 1000);
    meeting('m2', 'Old project', 2000, 999);
    item('keep', 'm1', 'decision', 'Keep', 1, 'rules@1', 'suggested', { status: 'open' });
    item('rej', 'm1', 'decision', 'Rejected', 2, 'rules@1', 'rejected', { status: 'open' });
    item('arch', 'm2', 'decision', 'Archived', 1, 'rules@1', 'suggested', { status: 'open' });
    expect((await db.allDecisions()).map(r => r.id)).toEqual(['keep']);
  });

  it('gives a typed decision no moment', async () => {
    meeting('m1', 'Standup', 1000);
    item('typed', 'm1', 'decision', 'Typed', 285_000_000, 'user', 'suggested');
    expect((await db.allDecisions())[0].anchorStartMs).toBeNull();
  });
});

describe('reviewItems', () => {
  it('returns only classified items waiting for review', async () => {
    meeting('m1', 'Standup', 1000);
    item('wait', 'm1', 'action', 'Check me', 1, 'rules@1', 'needs_review', { itemType: 'commitment' });
    item('unread', 'm1', 'action', 'Never classified', 2, 'rules@1', 'needs_review');
    item('fine', 'm1', 'action', 'Fine', 3, 'rules@1', 'suggested', { itemType: 'commitment' });
    item('done', 'm1', 'action', 'Confirmed', 4, 'rules@1', 'confirmed', { itemType: 'commitment' });
    expect((await db.reviewItems()).map(r => r.id)).toEqual(['wait']);
  });

  it('excludes an archived meeting', async () => {
    meeting('m2', 'Old project', 2000, 999);
    item('arch', 'm2', 'action', 'Hidden', 1, 'rules@1', 'needs_review', { itemType: 'commitment' });
    expect(await db.reviewItems()).toEqual([]);
  });
});
