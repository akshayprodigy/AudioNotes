import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../schema';
import { EMPTY_MEETINGS_SQL, PENDING_MEETINGS_SQL } from '../queries';

/**
 * The two library-wide queries that decide a meeting's fate by status, run against the real
 * DDL: the sweep that processes what is unfinished, and the "empty recordings" list that
 * deletes. A crash (`failed`) belongs to the first and must never reach the second.
 */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const t of ['meetings', 'utterances']) {
    const ddl = SCHEMA.find(s => s.trimStart().startsWith(`CREATE TABLE IF NOT EXISTS ${t} (`));
    if (!ddl) throw new Error(`no ${t} in SCHEMA`);
    db.exec(ddl);
  }
  return db;
}

function add(db: DatabaseSync, id: string, status: string, createdAt: number, failCount = 0) {
  db.prepare('INSERT INTO meetings(id, title, created_at, status, fail_count) VALUES (?,?,?,?,?)')
    .run(id, id, createdAt, status, failCount);
}

const ids = (db: DatabaseSync, sql: string) =>
  (db.prepare(sql).all() as { id: string }[]).map(r => r.id);

test('the sweep picks up unfinished and failed meetings, oldest first', () => {
  const db = freshDb();
  add(db, 'captured', 'captured', 1);
  add(db, 'vad', 'vad', 2);
  add(db, 'failed', 'failed', 3);
  add(db, 'done', 'done', 4);
  add(db, 'error', 'error', 5);
  add(db, 'recording', 'recording', 6);
  expect(ids(db, PENDING_MEETINGS_SQL)).toEqual(['captured', 'vad', 'failed']);
});

test('a meeting that failed three times is left for a person to retry', () => {
  const db = freshDb();
  add(db, 'twice', 'failed', 1, 2);
  add(db, 'thrice', 'failed', 2, 3);
  expect(ids(db, PENDING_MEETINGS_SQL)).toEqual(['twice']);
});

test('a crashed meeting is never offered for deletion as an empty recording', () => {
  const db = freshDb();
  add(db, 'silent', 'error', 1);
  add(db, 'crashed', 'failed', 2);
  expect(ids(db, EMPTY_MEETINGS_SQL)).toEqual(['silent']);
});
