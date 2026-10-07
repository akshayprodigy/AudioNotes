import { DatabaseSync } from 'node:sqlite';
import Storage from '../../native/NativeStorage';
import Player from '../../native/NativePlayer';
import { SCHEMA } from '../../db/schema';
import { SAMPLE_ID } from '../sampleId';
import { seedSample } from '../seedSample';

(Player as any).installSample = jest.fn(async (id: string) => ({ path: `/files/meetings/${id}/audio.pcm`, durationMs: 1 }));

/** The statements the seed hands native, run for real in SQLite against the real DDL. */
function ddl(table: string): string {
  const s = SCHEMA.find(x => x.trimStart().startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`));
  if (!s) throw new Error(`no ${table}`);
  return s;
}

async function seeded(): Promise<DatabaseSync> {
  (Storage.query as jest.Mock).mockImplementation(async () => JSON.stringify([{ n: 0 }]));
  const tx = Storage.transaction as jest.Mock;
  tx.mockClear();
  await seedSample();
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const t of ['meetings', 'utterances', 'speakers', 'minutes', 'items', 'item_sources', 'item_done', 'segments']) {
    db.exec(ddl(t));
  }
  for (const { sql, params } of JSON.parse(tx.mock.calls[0][0]) as { sql: string; params: unknown[] }[]) {
    db.prepare(sql).run(...(params as never[]));
  }
  return db;
}
const count = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('the seed against real SQLite', () => {
  it('is valid for the real schema and lands a finished meeting with every child row', async () => {
    const db = await seeded();
    const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(SAMPLE_ID) as Record<string, unknown>;
    expect(m).toMatchObject({ status: 'done', tier_used: 'free', language: 'en', audio_retained: 1 });
    expect(m.audio_path).toBe(`/files/meetings/${SAMPLE_ID}/audio.pcm`);
    expect(m.items_migrated_at).not.toBeNull();
    expect(count(db, 'utterances')).toBe(12);
    expect(count(db, 'speakers')).toBe(2);
    expect(count(db, 'items')).toBe(6);
    expect(count(db, 'item_done')).toBe(1);
  });

  it('reads back as the Free path writes it: owners follow the speaker row, one action has none', async () => {
    const db = await seeded();
    const actions = db.prepare("SELECT text, owner_json FROM items WHERE kind = 'action' ORDER BY anchor_start_ms, rowid").all() as {
      text: string;
      owner_json: string | null;
    }[];
    expect(actions).toHaveLength(4);
    expect(actions.filter(a => a.owner_json === null).map(a => a.text)).toEqual([
      'The review with the support team still needs to be booked before next Monday. — Unassigned (due before next Monday)',
    ]);
    const speakerIds = (db.prepare('SELECT id FROM speakers').all() as { id: string }[]).map(s => s.id);
    for (const a of actions.filter(x => x.owner_json)) {
      expect(speakerIds).toContain(JSON.parse(a.owner_json!).id);
    }
  });

  it('is removed whole by deleting the meeting row, with nothing left behind', async () => {
    const db = await seeded();
    db.prepare('DELETE FROM meetings WHERE id = ?').run(SAMPLE_ID);
    for (const t of ['utterances', 'speakers', 'minutes', 'items', 'item_sources', 'item_done', 'segments']) {
      expect([t, count(db, t)]).toEqual([t, 0]);
    }
  });
});
