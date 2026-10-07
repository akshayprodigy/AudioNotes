import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../schema';

/**
 * F14, the data layer: an action's owner is recorded as a speaker link (items.owner_json), the
 * worklist query hands that link to the screen, a hand correction that changes the owner drops it,
 * and a rename goes through the native call that records, renames and reindexes.
 *
 * Real SQL against the real DDL, like userItems.test.ts. The native half of the rename
 * (AudioDb.renameSpeaker / adoptRuleOwners / indexItems) is Kotlin over SQLCipher and is device-only.
 */
let mockSqlite: DatabaseSync;

jest.mock('../../native/NativeStorage', () => ({
  __esModule: true,
  default: {
    query: jest.fn(async (sql: string, params: string) => {
      const args = JSON.parse(params) as any[];
      const stmt = mockSqlite.prepare(sql);
      if (/^\s*SELECT/i.test(sql)) return JSON.stringify(stmt.all(...args));
      stmt.run(...args);
      return '[]';
    }),
    reindex: jest.fn(async () => {}),
    renameSpeaker: jest.fn(async () => {}),
  },
}));

import { db } from '../queries';
import Storage from '../../native/NativeStorage';

function ddlFor(name: string): string {
  const stmt = SCHEMA.find(
    s =>
      s.trimStart().startsWith(`CREATE TABLE IF NOT EXISTS ${name} (`) ||
      s.includes(`CREATE INDEX IF NOT EXISTS ${name} `),
  );
  if (!stmt) throw new Error(`no DDL for ${name} in SCHEMA`);
  return stmt;
}

const OWNER_S1 = JSON.stringify({ kind: 'speaker', id: 's1' });

beforeEach(() => {
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON;');
  for (const t of ['meetings', 'speakers', 'items', 'idx_items_meeting', 'item_sources', 'minutes']) {
    mockSqlite.exec(ddlFor(t));
  }
  mockSqlite
    .prepare("INSERT INTO meetings(id, title, created_at, duration_ms, status) VALUES('m1','Standup',1,0,'done')")
    .run();
  mockSqlite
    .prepare("INSERT INTO speakers(id, meeting_id, cluster_label, display_name) VALUES('s1','m1','S0','Priya')")
    .run();
  mockSqlite
    .prepare(
      "INSERT INTO items(id, meeting_id, kind, text, review, gen_version, anchor_start_ms, anchor_end_ms, created_at, owner_json) " +
        "VALUES('i1','m1','action','Send the report — Speaker 1','suggested','rules@1',5000,6000,0,?)",
    )
    .run(OWNER_S1);
  jest.clearAllMocks();
});
afterEach(() => mockSqlite.close());

const ownerOf = (id: string) =>
  (mockSqlite.prepare('SELECT owner_json AS o FROM items WHERE id=?').get(id) as any).o as string | null;

it('renameSpeaker goes through the native call that records, renames and reindexes', async () => {
  await db.renameSpeaker('s1', 'Priya Shah');
  expect(Storage.renameSpeaker).toHaveBeenCalledWith('s1', 'Priya Shah');
});

it('the worklist query carries owner_json to the screen, and speakerNames the current name', async () => {
  const rows = await db.allActions();
  expect(rows[0].ownerJson).toBe(OWNER_S1);
  // The stored text is untouched: that is the point, ticks and edits key on it.
  expect(rows[0].content).toBe('Send the report — Speaker 1');
  const names = await db.speakerNames();
  expect(names.get('m1\u0000s1')).toBe('Priya');
});

describe('reconcileItemOwner', () => {
  it('keeps the speaker link when the edit keeps the speaker', async () => {
    expect(await db.reconcileItemOwner('i1', 'Send the report, properly — Priya (due Friday)')).toBe(false);
    expect(ownerOf('i1')).toBe(OWNER_S1);
  });

  it('drops the speaker link when the person typed a different owner', async () => {
    expect(await db.reconcileItemOwner('i1', 'Send the report — Dana')).toBe(true);
    expect(JSON.parse(ownerOf('i1')!)).toEqual({ kind: 'person', name: 'Dana' });
  });

  it('drops it when the owner was removed from the text', async () => {
    expect(await db.reconcileItemOwner('i1', 'Send the report')).toBe(true);
    expect(JSON.parse(ownerOf('i1')!)).toEqual({ kind: 'unassigned' });
  });

  it('does not touch the review of the row', async () => {
    await db.reconcileItemOwner('i1', 'Send the report — Dana');
    expect((mockSqlite.prepare('SELECT review FROM items WHERE id=?').get('i1') as any).review).toBe('suggested');
  });

  it('is a no-op for an item with no speaker link', async () => {
    mockSqlite.prepare("UPDATE items SET owner_json = NULL WHERE id='i1'").run();
    expect(await db.reconcileItemOwner('i1', 'Send the report — Dana')).toBe(false);
    expect(ownerOf('i1')).toBeNull();
  });
});
