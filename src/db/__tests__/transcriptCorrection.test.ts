import { DatabaseSync } from 'node:sqlite';

/**
 * F15, the JS half: which native call a correction goes through. A transcript line is written
 * through natively (saveCorrection / revertCorrection — the SQL and the rule pass are Kotlin over
 * SQLCipher and device-only); every other edit keeps its side-table row and a reindex.
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
    saveCorrection: jest.fn(async () => true),
    revertCorrection: jest.fn(async () => true),
  },
}));

import { db } from '../queries';
import Storage from '../../native/NativeStorage';

const editRows = () => mockSqlite.prepare('SELECT target_kind, target_key, content FROM edits').all() as any[];

beforeEach(() => {
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = OFF;');
  // The Kotlin DDL (AudioDb.SCHEMA); the JS schema does not carry this table.
  mockSqlite.exec(
    'CREATE TABLE edits(meeting_id TEXT NOT NULL, target_kind TEXT NOT NULL, target_key TEXT NOT NULL, ' +
      'content TEXT NOT NULL, edited_at INTEGER NOT NULL, PRIMARY KEY (meeting_id, target_kind, target_key));',
  );
  jest.clearAllMocks();
});
afterEach(() => mockSqlite.close());

it('a transcript correction goes to the native write-through, not to a bare side-table insert', async () => {
  const rederived = await db.putEdit('m1', 'utterance', 'u1', 'we sold it to Innova');
  expect(Storage.saveCorrection).toHaveBeenCalledWith('m1', 'u1', 'we sold it to Innova');
  expect(rederived).toBe(true);
  expect(editRows()).toEqual([]); // native writes the edits row in the same transaction as the line
  expect(Storage.reindex).not.toHaveBeenCalled();
});

it('reverting a transcript correction goes to the native revert', async () => {
  expect(await db.clearEdit('m1', 'utterance', 'u1')).toBe(true);
  expect(Storage.revertCorrection).toHaveBeenCalledWith('m1', 'u1');
});

it('an item correction is still a side row plus a reindex, and re-derives nothing', async () => {
  expect(await db.putEdit('m1', 'item', 'i1', 'Send the report — Priya')).toBe(false);
  expect(editRows()).toEqual([{ target_kind: 'item', target_key: 'i1', content: 'Send the report — Priya' }]);
  expect(Storage.reindex).toHaveBeenCalledWith('m1');
  expect(Storage.saveCorrection).not.toHaveBeenCalled();
});

it('clearing an item correction deletes the row and reindexes', async () => {
  await db.putEdit('m1', 'summary', 'doc', 'Mine');
  expect(await db.clearEdit('m1', 'summary', 'doc')).toBe(false);
  expect(editRows()).toEqual([]);
  expect(Storage.revertCorrection).not.toHaveBeenCalled();
});
