import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../schema';

/**
 * The item queries the cross-meeting worklist is built on, run as SQL against a real SQLite
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
) {
  mockSqlite
    .prepare(
      'INSERT INTO items(id, meeting_id, kind, text, review, gen_version, anchor_start_ms, ' +
        'anchor_end_ms, created_at) VALUES(?,?,?,?,?,?,?,?,0)',
    )
    .run(id, meetingId, kind, text, review, genVersion, anchorStartMs, anchorStartMs + 1000);
}

function source(itemId: string, ordinal: number, startMs: number, utteranceId: string | null) {
  mockSqlite
    .prepare(
      'INSERT INTO item_sources(item_id, ordinal, start_ms, end_ms, char_start, char_end, ' +
        'utterance_id) VALUES(?,?,?,?,0,10,?)',
    )
    .run(itemId, ordinal, startMs, startMs + 500, utteranceId);
}

beforeEach(() => {
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON;');
  for (const t of ['meetings', 'items', 'idx_items_meeting', 'item_sources', 'item_done']) {
    mockSqlite.exec(ddlFor(t));
  }
});

afterEach(() => mockSqlite.close());

describe('allActions', () => {
  it('returns every action item in the library, newest meeting first', async () => {
    meeting('m1', 'Standup', 1000);
    meeting('m2', 'Client call', 2000);
    item('i1', 'm1', 'action', 'Send the report', 5000);
    item('i2', 'm2', 'action', 'Chase the invoice', 3000);

    const rows = await db.allActions();

    expect(rows.map(r => r.id)).toEqual(['i2', 'i1']);
    expect(rows[0]).toMatchObject({
      meetingId: 'm2',
      meetingTitle: 'Client call',
      createdAt: 2000,
      content: 'Chase the invoice',
      anchorStartMs: 3000,
    });
  });

  /**
   * Archiving is how somebody puts a finished meeting away. Its actions coming back in the
   * worklist is the failure that makes archiving useless, and it is one word in a SELECT.
   */
  it('excludes an archived meeting', async () => {
    meeting('m1', 'Standup', 1000);
    meeting('m2', 'Old project', 2000, 999);
    item('i1', 'm1', 'action', 'Send the report');
    item('i2', 'm2', 'action', 'Nobody owes this any more');

    expect((await db.allActions()).map(r => r.id)).toEqual(['i1']);
  });

  it('leaves decisions and questions out of the worklist', async () => {
    meeting('m1', 'Standup', 1000);
    item('i1', 'm1', 'action', 'Send the report');
    item('i2', 'm1', 'decision', 'We ship on Monday');
    item('i3', 'm1', 'question', 'Who owns the migration?');

    expect((await db.allActions()).map(r => r.id)).toEqual(['i1']);
  });

  it('orders one meeting’s actions by when they were said', async () => {
    meeting('m1', 'Standup', 1000);
    item('i-late', 'm1', 'action', 'Said last', 9000);
    item('i-early', 'm1', 'action', 'Said first', 1000);

    expect((await db.allActions()).map(r => r.id)).toEqual(['i-early', 'i-late']);
  });

  /**
   * A rejected action is by definition not outstanding, and `Reconciler` rule 4 keeps rejected
   * rows in `items` FOREVER on purpose — "keeping the no is what makes it stick". So the day
   * anything ships a reject gesture, every dismissed action returns as work in the one list whose
   * job is to be believed, with nothing failing to compile. Nothing writes 'rejected' today, which
   * is exactly why the filter goes in now rather than after somebody sees it.
   */
  it('leaves a rejected action out of the worklist', async () => {
    meeting('m1', 'Standup', 1000);
    item('i1', 'm1', 'action', 'Send the report');
    item('i2', 'm1', 'action', 'Somebody said no to this', 1000, 'rules@1', 'rejected');

    expect((await db.allActions()).map(r => r.id)).toEqual(['i1']);
  });

  /**
   * `ActionsScreen.group()` is a run-length grouper, so a meeting whose rows are interrupted
   * renders twice with its count split. Two meetings created in the same millisecond — an import,
   * a restore — would interleave deterministically on `anchor_start_ms` alone, because every
   * meeting's anchors start near 0.
   */
  it('keeps a meeting’s actions contiguous when two meetings share a created_at', async () => {
    meeting('m1', 'Standup', 1000);
    meeting('m2', 'Client call', 1000);
    item('a1', 'm1', 'action', 'First of m1', 0);
    item('a2', 'm1', 'action', 'Second of m1', 5000);
    item('b1', 'm2', 'action', 'First of m2', 1000);
    item('b2', 'm2', 'action', 'Second of m2', 6000);

    const ids = (await db.allActions()).map(r => r.meetingId);
    expect(ids.slice(0, 2).every(m => m === ids[0])).toBe(true);
    expect(ids.slice(2).every(m => m === ids[2])).toBe(true);
    expect(ids[0]).not.toBe(ids[2]);
  });

  /**
   * `items` has no `source` column; `gen_version` carries what wrote the row. The worklist keeps
   * the field because a hand-typed item is not something the pipeline may quietly rewrite, and
   * Task 12 is what starts writing `gen_version='user'` rows.
   */
  it('reports a hand-typed item as the user’s', async () => {
    meeting('m1', 'Standup', 1000);
    item('i1', 'm1', 'action', 'Ring the supplier', 0, 'user');
    item('i2', 'm1', 'action', 'Send the report', 1000);

    const rows = await db.allActions();
    expect(rows.find(r => r.id === 'i1')!.source).toBe('user');
    expect(rows.find(r => r.id === 'i2')!.source).toBe('rule');
  });
});

describe('doneItemIds', () => {
  it('keys a tick on the meeting and the item, joined by a NUL', async () => {
    meeting('m1', 'Standup', 1000);
    item('i1', 'm1', 'action', 'Send the report');
    await db.setItemDone('m1', 'i1', true);

    // A NUL, not a space: the separator has to be a character neither half can contain.
    expect(await db.doneItemIds()).toEqual(new Set(['m1\u0000i1']));
  });

  it('forgets a tick that was taken back', async () => {
    meeting('m1', 'Standup', 1000);
    item('i1', 'm1', 'action', 'Send the report');
    await db.setItemDone('m1', 'i1', true);
    await db.setItemDone('m1', 'i1', false);

    expect(await db.doneItemIds()).toEqual(new Set());
  });

  it('ticks the item, not its text — a reworded item stays done', async () => {
    meeting('m1', 'Standup', 1000);
    item('i1', 'm1', 'action', 'Send the report');
    await db.setItemDone('m1', 'i1', true);
    // What a reprocess does: the same item id, re-recognised wording.
    mockSqlite.prepare('UPDATE items SET text = ? WHERE id = ?').run('Send the reports', 'i1');

    const rows = await db.allActions();
    const done = await db.doneItemIds();
    expect(done.has(`${rows[0].meetingId}\u0000${rows[0].id}`)).toBe(true);
  });

  /**
   * `item_done` deliberately has NO foreign key to `items` — a cascade there would wipe every tick
   * on every reprocess — so two meetings each holding a tick for item id 'i1' is representable
   * even though `items.id` is a primary key and cannot itself repeat. That is the shape a key
   * dropping the meeting half collapses into one entry, silently.
   */
  it('keeps two meetings’ ticks apart when they share an item id', async () => {
    meeting('m1', 'Standup', 1000);
    meeting('m2', 'Client call', 2000);
    item('i1', 'm1', 'action', 'Send the report');
    await db.setItemDone('m1', 'i1', true);
    await db.setItemDone('m2', 'i1', true);

    expect(await db.doneItemIds()).toEqual(new Set(['m1\u0000i1', 'm2\u0000i1']));
  });
});

describe('items', () => {
  it('hands each item its own evidence, in the order it was said', async () => {
    meeting('m1', 'Standup', 1000);
    item('i1', 'm1', 'decision', 'We ship on Monday', 1000);
    item('i2', 'm1', 'action', 'Send the report', 5000);
    // Written out of order on purpose: a grouping that ignores the key passes if every item is
    // handed the same list, which is the defect this shape caught on the Kotlin side.
    source('i2', 0, 5000, 'u2');
    source('i1', 1, 7000, null);
    source('i1', 0, 1000, 'u1');

    const rows = await db.items('m1');

    expect(rows.map(r => r.id)).toEqual(['i1', 'i2']);
    expect(rows[0].sources.map(s => s.startMs)).toEqual([1000, 7000]);
    expect(rows[1].sources.map(s => s.startMs)).toEqual([5000]);
    expect(rows[0].sources[1].utteranceId).toBeNull();
    expect(rows[0]).toMatchObject({ kind: 'decision', text: 'We ship on Monday', review: 'suggested' });
  });

  it('returns an item with no evidence rather than dropping it', async () => {
    meeting('m1', 'Standup', 1000);
    item('i1', 'm1', 'action', 'Send the report');

    const rows = await db.items('m1');
    expect(rows).toHaveLength(1);
    expect(rows[0].sources).toEqual([]);
  });

  it('does not reach into another meeting', async () => {
    meeting('m1', 'Standup', 1000);
    meeting('m2', 'Client call', 2000);
    item('i1', 'm1', 'action', 'Send the report');
    item('i2', 'm2', 'action', 'Chase the invoice');
    source('i2', 0, 3000, 'u9');

    expect((await db.items('m1')).map(r => r.id)).toEqual(['i1']);
  });
});
