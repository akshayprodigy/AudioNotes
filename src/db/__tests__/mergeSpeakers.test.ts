import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../schema';

/**
 * F19 (D26): merging two speakers, run as SQL against a real SQLite database.
 *
 * `mergeSpeakers` used to be two bare statements — UPDATE the lines, DELETE the speaker — with no
 * transaction and no `edits` rows. A failure between them left lines on a speaker that was about to
 * be deleted, and a Redo that re-diarized (AudioDb.assignSpeakers) dropped the merge entirely,
 * because only a `target_kind = 'speaker'` edit survives re-clustering (SpeakerRepair.kt).
 *
 * The transaction itself is native (`Storage.transaction` → AudioDb.runTransaction), so the
 * stand-in below implements the contract that method documents: all statements or none. What is
 * proven HERE is that `mergeSpeakers` sends its writes through that one call, in an order that
 * leaves the data right, and that the SQL is correct against the real DDL. What is NOT proven
 * here is that the Android SQLCipher handle really rolls back — that is a device check.
 *
 * `edits` is created from its own DDL below because src/db/schema.ts (the readable copy) lacks it;
 * the statement is copied from AudioDb.SCHEMA.
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
    transaction: jest.fn(async (statementsJson: string) => {
      const statements = JSON.parse(statementsJson) as { sql: string; params: unknown[] }[];
      mockSqlite.exec('BEGIN');
      try {
        for (const s of statements) mockSqlite.prepare(s.sql).run(...(s.params as any[]));
        mockSqlite.exec('COMMIT');
      } catch (e) {
        mockSqlite.exec('ROLLBACK');
        throw e;
      }
    }),
    reindex: jest.fn(async () => {}),
  },
}));

import { db } from '../queries';

const EDITS_DDL = `CREATE TABLE IF NOT EXISTS edits(
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target_key TEXT NOT NULL,
  content TEXT NOT NULL,
  edited_at INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, target_kind, target_key));`;

function ddlFor(name: string): string {
  const stmt = SCHEMA.find(s => s.trimStart().startsWith(`CREATE TABLE IF NOT EXISTS ${name} (`));
  if (!stmt) throw new Error(`no DDL for ${name} in SCHEMA`);
  return stmt;
}

const lineSpeakers = (meetingId: string) =>
  (
    mockSqlite
      .prepare('SELECT id, speaker_id FROM utterances WHERE meeting_id = ? ORDER BY id')
      .all(meetingId) as unknown as { id: string; speaker_id: string }[]
  ).map(r => [r.id, r.speaker_id]);

const speakerIds = (meetingId: string) =>
  (
    mockSqlite
      .prepare('SELECT id FROM speakers WHERE meeting_id = ? ORDER BY id')
      .all(meetingId) as unknown as { id: string }[]
  ).map(r => r.id);

const speakerEdits = (meetingId: string) =>
  (
    mockSqlite
      .prepare(
        "SELECT target_key AS k, content AS c FROM edits WHERE meeting_id = ? AND target_kind = 'speaker' ORDER BY target_key",
      )
      .all(meetingId) as unknown as { k: string; c: string }[]
  ).map(r => [r.k, r.c]);

beforeEach(() => {
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON;');
  for (const t of ['meetings', 'utterances', 'speakers', 'items']) mockSqlite.exec(ddlFor(t));
  mockSqlite.exec(EDITS_DDL);
  for (const m of ['m1', 'm2']) {
    mockSqlite
      .prepare("INSERT INTO meetings(id, title, created_at, duration_ms, status) VALUES(?,?,0,0,'done')")
      .run(m, m);
    for (const sp of ['a', 'b', 'c']) {
      mockSqlite
        .prepare('INSERT INTO speakers(id, meeting_id, cluster_label, display_name) VALUES(?,?,?,?)')
        .run(`${m}:${sp}`, m, sp, `Speaker ${sp}`);
    }
  }
  // m1: lines 1-2 are speaker a, 3-4 are b, 5 is c. m2 mirrors it under its own ids.
  const put = (m: string, n: number, sp: string) =>
    mockSqlite
      .prepare('INSERT INTO utterances(id, meeting_id, start_ms, end_ms, speaker_id, text) VALUES(?,?,?,?,?,?)')
      .run(`${m}:u${n}`, m, n * 1000, n * 1000 + 900, `${m}:${sp}`, `line ${n}`);
  for (const m of ['m1', 'm2']) {
    put(m, 1, 'a');
    put(m, 2, 'a');
    put(m, 3, 'b');
    put(m, 4, 'b');
    put(m, 5, 'c');
  }
});

afterEach(() => mockSqlite.close());

describe('mergeSpeakers', () => {
  it('repoints an action owned by the dropped speaker at the kept one, and leaves other owners alone', async () => {
    const put = (id: string, m: string, owner: string | null) =>
      mockSqlite
        .prepare(
          "INSERT INTO items(id, meeting_id, kind, text, owner_json, gen_version, anchor_start_ms, anchor_end_ms, created_at) VALUES(?,?, 'action', 'x', ?, 'v1', 0, 1, 0)",
        )
        .run(id, m, owner);
    put('i-dropped', 'm1', JSON.stringify({ kind: 'speaker', id: 'm1:b' }));
    put('i-dropped-reordered', 'm1', JSON.stringify({ id: 'm1:b', kind: 'speaker' }));
    put('i-kept', 'm1', JSON.stringify({ kind: 'speaker', id: 'm1:c' }));
    put('i-person', 'm1', JSON.stringify({ kind: 'person', name: 'Maya' }));
    put('i-none', 'm1', null);
    put('i-other-meeting', 'm2', JSON.stringify({ kind: 'speaker', id: 'm2:b' }));

    await db.mergeSpeakers('m1', 'm1:a', 'm1:b');

    const owners = Object.fromEntries(
      (mockSqlite.prepare('SELECT id, owner_json FROM items').all() as unknown as { id: string; owner_json: string | null }[]).map(r => [r.id, r.owner_json]),
    );
    expect(owners['i-dropped']).toBe(JSON.stringify({ kind: 'speaker', id: 'm1:a' }));
    expect(owners['i-dropped-reordered']).toBe(JSON.stringify({ kind: 'speaker', id: 'm1:a' }));
    expect(owners['i-kept']).toBe(JSON.stringify({ kind: 'speaker', id: 'm1:c' }));
    expect(owners['i-person']).toBe(JSON.stringify({ kind: 'person', name: 'Maya' }));
    expect(owners['i-none']).toBeNull();
    expect(owners['i-other-meeting']).toBe(JSON.stringify({ kind: 'speaker', id: 'm2:b' }));
  });

  it('moves every line to the kept speaker and drops the other, and touches nothing else', async () => {
    await db.mergeSpeakers('m1', 'm1:a', 'm1:b');

    expect(lineSpeakers('m1')).toEqual([
      ['m1:u1', 'm1:a'],
      ['m1:u2', 'm1:a'],
      ['m1:u3', 'm1:a'],
      ['m1:u4', 'm1:a'],
      ['m1:u5', 'm1:c'],
    ]);
    expect(speakerIds('m1')).toEqual(['m1:a', 'm1:c']);
    // The other meeting is exactly as it was.
    expect(lineSpeakers('m2').map(r => r[1])).toEqual(['m2:a', 'm2:a', 'm2:b', 'm2:b', 'm2:c']);
    expect(speakerIds('m2')).toEqual(['m2:a', 'm2:b', 'm2:c']);
  });

  it('records a speaker edit for each moved line, so re-diarization keeps the merge', async () => {
    await db.mergeSpeakers('m1', 'm1:a', 'm1:b');

    // Only the lines that MOVED are recorded: the kept speaker's own lines were never an edit.
    expect(speakerEdits('m1')).toEqual([
      ['m1:u3', 'm1:a'],
      ['m1:u4', 'm1:a'],
    ]);
    expect(speakerEdits('m2')).toEqual([]);
  });

  it('repoints an earlier hand-assigned line at the speaker that replaces the dropped one', async () => {
    // A person had earlier said line 5 was speaker b; b is now being merged into a.
    mockSqlite
      .prepare("INSERT INTO edits(meeting_id, target_kind, target_key, content, edited_at) VALUES('m1','speaker','m1:u5','m1:b',1)")
      .run();

    await db.mergeSpeakers('m1', 'm1:a', 'm1:b');

    // Left alone it would name a speaker row that no longer exists, and SpeakerRepair.reapplicable
    // would discard it on the next Redo.
    expect(speakerEdits('m1')).toContainEqual(['m1:u5', 'm1:a']);
  });

  it('is all-or-nothing: a failure in the last statement undoes the first three', async () => {
    // Fail the DELETE, the final statement.
    mockSqlite.exec(
      "CREATE TRIGGER no_delete BEFORE DELETE ON speakers BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );

    await expect(db.mergeSpeakers('m1', 'm1:a', 'm1:b')).rejects.toThrow('disk full');

    expect(lineSpeakers('m1').map(r => r[1])).toEqual(['m1:a', 'm1:a', 'm1:b', 'm1:b', 'm1:c']);
    expect(speakerIds('m1')).toEqual(['m1:a', 'm1:b', 'm1:c']);
    expect(speakerEdits('m1')).toEqual([]);
  });

  it('sends its writes as one transaction call and none as bare queries', async () => {
    const Storage = require('../../native/NativeStorage').default;
    Storage.query.mockClear();
    Storage.transaction.mockClear();

    await db.mergeSpeakers('m1', 'm1:a', 'm1:b');

    expect(Storage.transaction).toHaveBeenCalledTimes(1);
    expect(Storage.query).not.toHaveBeenCalled();
  });
});
