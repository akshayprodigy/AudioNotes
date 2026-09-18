import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../schema';

/**
 * Executes the REAL DDL for the evidence-spine tables from src/db/schema.ts in an in-memory
 * SQLite database and reads the result back with PRAGMA introspection.
 *
 * This replaces an earlier version of this file that parsed the CREATE TABLE strings with a
 * hand-rolled comma splitter. That approach had a real false pass: an unbalanced paren inside a
 * string literal (`DEFAULT '('`, valid SQLite) desynchronised its depth counter and swallowed
 * every column after it, so a test asserting item_done does NOT contain item_key passed while
 * item_key was in the table. It also could not see types, NOT NULL, defaults, foreign keys and
 * their delete actions, primary-key composition, or index column order — and it could not prove
 * the DDL parses at all, which is the failure (e.g. a trailing comma before a closing paren) that
 * would stop the app opening its database on every device. Real SQLite execution closes all of
 * that. See SchemaTest.kt for the JVM-side smoke check, which cannot run SQLite and says so.
 *
 * Only meetings + the three new tables are executed, not the whole of SCHEMA: node:sqlite's
 * bundled engine has no fts5 module, and meetings_fts (see the schema-drift note below) would
 * fail to create and take every test in this file down with it.
 */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
   db.exec(ddlFor('meetings'));
   db.exec(ddlFor('speakers'));
   db.exec(ddlFor('people'));
   db.exec(ddlFor('items'));
  db.exec(indexDdlFor('idx_items_meeting'));
  db.exec(ddlFor('item_sources'));
  db.exec(ddlFor('item_done'));
  db.exec(ddlFor('search_vec'));
  db.exec(indexDdlFor('search_vec_meeting'));
  db.exec(ddlFor('asks'));
  return db;
}

function ddlFor(table: string): string {
  const stmt = SCHEMA.find(s => s.trimStart().startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`));
  if (!stmt) throw new Error(`no CREATE TABLE IF NOT EXISTS ${table} in SCHEMA`);
  return stmt;
}

function indexDdlFor(name: string): string {
  const stmt = SCHEMA.find(s => s.includes(`CREATE INDEX IF NOT EXISTS ${name} `));
  if (!stmt) throw new Error(`no CREATE INDEX IF NOT EXISTS ${name} in SCHEMA`);
  return stmt;
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: unknown;
  pk: number; // 0 = not in the PK; otherwise its 1-based position in a composite key
}

interface ForeignKeyInfo {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

function columnsOf(db: DatabaseSync, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[];
}

function foreignKeysOf(db: DatabaseSync, table: string): ForeignKeyInfo[] {
  return db.prepare(`PRAGMA foreign_key_list(${table})`).all() as unknown as ForeignKeyInfo[];
}

function column(cols: ColumnInfo[], name: string): ColumnInfo {
  const c = cols.find(x => x.name === name);
  if (!c) throw new Error(`no column ${name}`);
  return c;
}

describe('schema.ts evidence tables (executed in real SQLite)', () => {
  it('the DDL parses and every statement executes', () => {
    // freshDb() throwing IS the failure this test exists to catch — invalid DDL that would stop
    // the app opening its database on every device, which a string-based parser cannot see.
    expect(() => freshDb()).not.toThrow();
  });

  /**
   * The mirror's own table, asserted because the mirror is what drifts.
   *
   * `meetings` is not an evidence-spine table and was not asserted here at all, which is how
   * `title_edited_at` came to be in AudioDb and not in this file. The list below is the UNION of
   * AudioDb's `meetings` CREATE TABLE and every `("meetings", ...)` entry in its ADDED_COLUMNS,
   * because on a real device those two run one after the other and the union is the shape every
   * query actually sees. Change AudioDb, change this.
   */
  describe('meetings', () => {
    it('has every column AudioDb creates or adds', () => {
      const cols = columnsOf(freshDb(), 'meetings').map(c => c.name).sort();
      expect(cols).toEqual(
        [
          'id', 'title', 'created_at', 'duration_ms', 'language', 'status', 'tier_used',
          'audio_path', 'audio_retained', 'archived_at', 'summary_line', 'title_edited_at',
          'transcribe_forced_at', 'forced_from_language', 'announced_at', 'announced_lag_ms', 'diar_skipped_reason',
          'items_migrated_at', 'embedded_at', 'template', 'template_source',
        ].sort(),
      );
    });

    /**
     * The migration marker, and both halves of it matter.
     *
     * INTEGER because it is an epoch, and nullable with NO default because NULL is what every
     * existing row starts with and is the only value that means "the rules have never been run
     * over this meeting". A DEFAULT here would declare an entire existing library already
     * migrated the moment the ALTER ran, and unmigratedMeetings would answer 0 forever — the
     * confident false negative this column exists to prevent, restored by the column itself.
     */
    it('items_migrated_at is a nullable INTEGER with no default', () => {
      const col = column(columnsOf(freshDb(), 'meetings'), 'items_migrated_at');
      expect(col.type).toBe('INTEGER');
      expect(col.notnull).toBe(0);
      expect(col.dflt_value).toBe(null);
    });

    /**
     * The meaning-index marker, the same shape for the same reason: NULL is "this meeting's
     * current words are not all embedded", which is what every existing row starts as and what
     * every writer of words resets it to. A DEFAULT would declare the whole library indexed.
     */
    it('embedded_at is a nullable INTEGER with no default', () => {
      const col = column(columnsOf(freshDb(), 'meetings'), 'embedded_at');
      expect(col.type).toBe('INTEGER');
      expect(col.notnull).toBe(0);
      expect(col.dflt_value).toBe(null);
    });

    /**
     * Sub-project 6a (meeting templates): the type, and how it got there. NULL is "not suggested
     * yet" (an unprocessed meeting) as well as "no cue cleared the threshold" (the suggester's own
     * `general`) — the same NULL either way, since both read as "nothing to show but General" on
     * the Summary chip. A DEFAULT of 'general' would make the two indistinguishable from SQL,
     * which TemplateSuggester's "only suggest once" check (meetings.template_source IS NULL)
     * depends on telling apart.
     */
    it('template is a nullable TEXT with no default', () => {
      const col = column(columnsOf(freshDb(), 'meetings'), 'template');
      expect(col.type).toBe('TEXT');
      expect(col.notnull).toBe(0);
      expect(col.dflt_value).toBe(null);
    });

    it('template_source is a nullable TEXT with no default', () => {
      const col = column(columnsOf(freshDb(), 'meetings'), 'template_source');
      expect(col.type).toBe('TEXT');
      expect(col.notnull).toBe(0);
      expect(col.dflt_value).toBe(null);
    });
  });

  /** Sub-project 5: the vectors behind meaning search, and what a meeting was asked. */
  describe('search_vec and asks', () => {
    it('search_vec has the columns the retriever scans, and no foreign key (like search_fts)', () => {
      const db = freshDb();
      const cols = columnsOf(db, 'search_vec').map(c => c.name).sort();
      expect(cols).toEqual(
        ['meeting_id', 'kind', 'ref_id', 'start_ms', 'end_ms', 'speaker_id', 'text', 'hash', 'vec', 'model'].sort(),
      );
      expect(foreignKeysOf(db, 'search_vec')).toEqual([]);
      expect(column(columnsOf(db, 'search_vec'), 'vec').type).toBe('BLOB');
      expect(column(columnsOf(db, 'search_vec'), 'hash').notnull).toBe(1);
    });

    it('search_vec is indexed by meeting, which is how Ask narrows the scan', () => {
      const idx = freshDb().prepare('PRAGMA index_info(search_vec_meeting)').all() as { name: string }[];
      expect(idx.map(i => i.name)).toEqual(['meeting_id']);
    });

    it('asks cascade with their meeting', () => {
      const db = freshDb();
      const cols = columnsOf(db, 'asks').map(c => c.name).sort();
      expect(cols).toEqual(['id', 'meeting_id', 'question', 'answer', 'cites_json', 'asked_at'].sort());
      const fk = foreignKeysOf(db, 'asks');
      expect(fk).toHaveLength(1);
      expect(fk[0].table).toBe('meetings');
      expect(fk[0].on_delete).toBe('CASCADE');
    });
  });

  describe('items', () => {
    it('has exactly the fourteen expected columns', () => {
      const cols = columnsOf(freshDb(), 'items').map(c => c.name).sort();
      expect(cols).toEqual(
        [
          'id', 'meeting_id', 'kind', 'item_type', 'status', 'text', 'owner_json',
          'date_said', 'date_norm', 'review', 'gen_version', 'anchor_start_ms',
          'anchor_end_ms', 'created_at',
        ].sort(),
      );
    });

    /**
     * anchor_start_ms is what idx_items_meeting orders by and what Task 6's items() query
     * ORDER BYs. TEXT affinity on an INTEGER column still accepts and stores integers, so a
     * wrong declared type here is invisible until sort order goes lexicographic — '10' before
     * '9' — and a meeting's items come back scrambled. This is the assertion that would have
     * caught it: nothing else in this file reads `.type`.
     */
    it('every column has its declared SQLite type', () => {
      const cols = columnsOf(freshDb(), 'items');
      const expected: Record<string, string> = {
        id: 'TEXT', meeting_id: 'TEXT', kind: 'TEXT', item_type: 'TEXT', status: 'TEXT',
        text: 'TEXT', owner_json: 'TEXT', date_said: 'TEXT', date_norm: 'INTEGER',
        review: 'TEXT', gen_version: 'TEXT', anchor_start_ms: 'INTEGER',
        anchor_end_ms: 'INTEGER', created_at: 'INTEGER',
      };
      for (const [name, type] of Object.entries(expected)) {
        expect(column(cols, name).type).toBe(type);
      }
    });

    /**
     * Asserted directly rather than through a side effect: both behavioural tests below omit
     * `review` from their INSERT column list, so if the default were dropped they would fail on
     * a NOT NULL violation instead — inside a test named for something else entirely, and only
     * until someone "completes" that column list, which would silently delete the coverage.
     */
    it("review defaults to 'suggested'", () => {
      const cols = columnsOf(freshDb(), 'items');
      expect(column(cols, 'review').dflt_value).toBe("'suggested'");
    });

    /**
     * The five Phase B columns exist now so the classifier lands as a write, not a migration —
     * nothing reads them yet, so nothing else would notice one becoming wrongly NOT NULL (which
     * would break every free-tier insert, since nothing supplies them) or silently dropped.
     */
    it('the five Phase B columns are nullable', () => {
      const cols = columnsOf(freshDb(), 'items');
      for (const name of ['item_type', 'status', 'owner_json', 'date_said', 'date_norm']) {
        expect(column(cols, name).notnull).toBe(0);
      }
    });

    it('id, meeting_id, kind, text, review, gen_version and the anchors are NOT NULL', () => {
      const cols = columnsOf(freshDb(), 'items');
      for (const name of [
        'id', 'meeting_id', 'kind', 'text', 'review', 'gen_version',
        'anchor_start_ms', 'anchor_end_ms', 'created_at',
      ]) {
        expect(column(cols, name).notnull).toBe(1);
      }
    });

    /**
     * SQLite's TEXT PRIMARY KEY allows NULL unless said explicitly — only INTEGER PRIMARY KEY
     * implies NOT NULL. Without it, two NULL-id items would not even collide with each other.
     */
    it('id is NOT NULL, closing SQLite\'s TEXT PRIMARY KEY NULL quirk', () => {
      const db = freshDb();
      const idCol = column(columnsOf(db, 'items'), 'id');
      expect(idCol.pk).toBe(1);
      expect(idCol.notnull).toBe(1);
      db.exec("INSERT INTO meetings(id, title, created_at) VALUES ('m1','Standup',0)");
      expect(() =>
        db
          .prepare(
            `INSERT INTO items(id, meeting_id, kind, text, gen_version, anchor_start_ms,
               anchor_end_ms, created_at) VALUES (NULL, ?, 'action', 't', 'rules@1', 0, 0, 0)`,
          )
          .run('m1'),
      ).toThrow(/NOT NULL/);
    });

    it('meeting_id references meetings, cascading on delete', () => {
      const fk = foreignKeysOf(freshDb(), 'items')[0];
      expect(fk).toMatchObject({ table: 'meetings', from: 'meeting_id', to: 'id', on_delete: 'CASCADE' });
    });

    it('idx_items_meeting covers (meeting_id, anchor_start_ms), in that order', () => {
      const db = freshDb();
      const names = (db.prepare("PRAGMA index_list('items')").all() as Array<{ name: string }>).map(
        i => i.name,
      );
      expect(names).toContain('idx_items_meeting');
      const idxCols = (
        db.prepare("PRAGMA index_info('idx_items_meeting')").all() as Array<{ name: string }>
      ).map(i => i.name);
      expect(idxCols).toEqual(['meeting_id', 'anchor_start_ms']);
    });
  });

  describe('item_sources', () => {
    it('has exactly the seven expected columns', () => {
      const cols = columnsOf(freshDb(), 'item_sources').map(c => c.name).sort();
      expect(cols).toEqual(
        ['item_id', 'ordinal', 'start_ms', 'end_ms', 'char_start', 'char_end', 'utterance_id'].sort(),
      );
    });

    /**
     * start_ms/end_ms/char_start/char_end are all sorted or range-compared by callers (Task 6+);
     * TEXT affinity on any of them would be invisible until a comparison goes lexicographic.
     */
    it('every column has its declared SQLite type', () => {
      const cols = columnsOf(freshDb(), 'item_sources');
      const expected: Record<string, string> = {
        item_id: 'TEXT', ordinal: 'INTEGER', start_ms: 'INTEGER', end_ms: 'INTEGER',
        char_start: 'INTEGER', char_end: 'INTEGER', utterance_id: 'TEXT',
      };
      for (const [name, type] of Object.entries(expected)) {
        expect(column(cols, name).type).toBe(type);
      }
    });

    /**
     * Both producers (evidence.ts, evidence.h) always emit a span, and a source without one is
     * meaningless. Nullable here would be silently dangerous rather than absent: a missing span
     * reads back through most cursor APIs as 0, i.e. "starts at the beginning of the turn", and
     * Task 10's provenance UI would highlight the wrong text instead of visibly failing.
     */
    it('char_start and char_end are NOT NULL', () => {
      const cols = columnsOf(freshDb(), 'item_sources');
      expect(column(cols, 'char_start').notnull).toBe(1);
      expect(column(cols, 'char_end').notnull).toBe(1);
    });

    it('start_ms, end_ms, item_id and ordinal are NOT NULL; utterance_id is nullable', () => {
      const cols = columnsOf(freshDb(), 'item_sources');
      for (const name of ['item_id', 'ordinal', 'start_ms', 'end_ms']) {
        expect(column(cols, name).notnull).toBe(1);
      }
      expect(column(cols, 'utterance_id').notnull).toBe(0);
    });

    it('the primary key is the (item_id, ordinal) composite, not a surrogate', () => {
      const cols = columnsOf(freshDb(), 'item_sources');
      expect(column(cols, 'item_id').pk).toBe(1);
      expect(column(cols, 'ordinal').pk).toBe(2);
    });

    it('item_id references items, cascading on delete', () => {
      const fk = foreignKeysOf(freshDb(), 'item_sources')[0];
      expect(fk).toMatchObject({ table: 'items', from: 'item_id', to: 'id', on_delete: 'CASCADE' });
    });

    /**
     * idx_item_sources_start was removed: every item_sources read is
     * `WHERE item_id IN (...) ORDER BY item_id, ordinal`, already served by the composite
     * PRIMARY KEY's autoindex, so a separate index on start_ms was pure write amplification on
     * every source row of every reprocess with no reader anywhere in Tasks 6-13. Adding one back
     * later is cheap — CREATE INDEX IF NOT EXISTS runs on every open, not only on fresh installs.
     */
    it('has no index beyond the composite primary key\'s autoindex', () => {
      const names = (
        db => (db.prepare("PRAGMA index_list('item_sources')").all() as Array<{ name: string }>).map(i => i.name)
      )(freshDb());
      expect(names).not.toContain('idx_item_sources_start');
      expect(names).toHaveLength(1); // just the PK's autoindex
    });
  });

  describe('item_done', () => {
    it('has exactly meeting_id, item_id and done_at — not item_key', () => {
      const names = columnsOf(freshDb(), 'item_done').map(c => c.name);
      expect(names.sort()).toEqual(['meeting_id', 'item_id', 'done_at'].sort());
      expect(names).not.toContain('item_key');
    });

    it('the primary key is the (meeting_id, item_id) composite', () => {
      const cols = columnsOf(freshDb(), 'item_done');
      expect(column(cols, 'meeting_id').pk).toBe(1);
      expect(column(cols, 'item_id').pk).toBe(2);
    });

    it('every column has its declared SQLite type', () => {
      const cols = columnsOf(freshDb(), 'item_done');
      const expected: Record<string, string> = {
        meeting_id: 'TEXT', item_id: 'TEXT', done_at: 'INTEGER',
      };
      for (const [name, type] of Object.entries(expected)) {
        expect(column(cols, name).type).toBe(type);
      }
    });

    /**
     * The design decision this table exists for, proved rather than merely commented: item_id
     * has NO foreign key to items(id), so deleting/replacing an item does not touch its tick.
     * Task 6's replaceItems deletes and re-inserts every item row on every reprocess — an
     * ON DELETE CASCADE here would wipe every tick on every reprocess, the exact failure
     * item_done exists to end. If someone "fixes" the missing FK, this is the test that catches
     * it, both structurally and behaviourally.
     */
    it('has no foreign key to items — deleting an item leaves its tick standing', () => {
      const db = freshDb();
      const fkTables = foreignKeysOf(db, 'item_done').map(fk => fk.table);
      expect(fkTables).not.toContain('items');
      expect(fkTables).toEqual(['meetings']);

      db.exec("INSERT INTO meetings(id, title, created_at) VALUES ('m1','Standup',0)");
      db.exec(
        `INSERT INTO items(id, meeting_id, kind, text, gen_version, anchor_start_ms,
           anchor_end_ms, created_at) VALUES ('i1','m1','action','Send it','rules@1',0,0,0)`,
      );
      db.exec("INSERT INTO item_done(meeting_id, item_id, done_at) VALUES ('m1','i1',123)");

      db.exec("DELETE FROM items WHERE id='i1'");

      expect(
        db.prepare("SELECT * FROM item_done WHERE meeting_id='m1' AND item_id='i1'").all(),
      ).toHaveLength(1);
    });

    it('meeting_id still cascades from meetings — deleting a meeting deletes its ticks', () => {
      const db = freshDb();
      db.exec("INSERT INTO meetings(id, title, created_at) VALUES ('m1','Standup',0)");
      db.exec(
        `INSERT INTO items(id, meeting_id, kind, text, gen_version, anchor_start_ms,
           anchor_end_ms, created_at) VALUES ('i1','m1','action','Send it','rules@1',0,0,0)`,
      );
      db.exec("INSERT INTO item_done(meeting_id, item_id, done_at) VALUES ('m1','i1',123)");

      db.exec("DELETE FROM meetings WHERE id='m1'");

      expect(db.prepare('SELECT * FROM item_done').all()).toHaveLength(0);
      expect(db.prepare('SELECT * FROM items').all()).toHaveLength(0);
    });
  });
});

/** Phase 4: remembered voices. Two columns added to speakers, both nullable with no default. */
describe('speakers', () => {
  it('has voice BLOB and suggested_person TEXT, both nullable with no default', () => {
    const db = freshDb();
    const cols = columnsOf(db, 'speakers');
    const voice = column(cols, 'voice');
    expect(voice.type).toBe('BLOB');
    expect(voice.notnull).toBe(0);
    expect(voice.dflt_value).toBeNull();
    const suggested = column(cols, 'suggested_person');
    expect(suggested.type).toBe('TEXT');
    expect(suggested.notnull).toBe(0);
    expect(suggested.dflt_value).toBeNull();
  });
});

/** Phase 4: the people table — one row per named voice. */
describe('people', () => {
  it('has exactly the seven expected columns with their types', () => {
    const expected: Record<string, string> = {
      id: 'TEXT', name: 'TEXT', voice: 'BLOB', dim: 'INTEGER',
      samples: 'INTEGER', created_at: 'INTEGER', updated_at: 'INTEGER',
    };
    const cols = columnsOf(freshDb(), 'people');
    expect(cols.map(c => c.name).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, type] of Object.entries(expected)) {
      expect(column(cols, name).type).toBe(type);
    }
  });

  it('name is UNIQUE COLLATE NOCASE', () => {
    const ddl = ddlFor('people');
    expect(ddl).toContain('name TEXT NOT NULL UNIQUE COLLATE NOCASE');
  });
});

describe('marks', () => {
  it('exists, keyed on time, cascading with the meeting', () => {
    const ddl = ddlFor('marks');
    for (const col of ['id', 'meeting_id', 'at_ms', 'created_at']) expect(ddl).toContain(col);
    expect(ddl).toContain('ON DELETE CASCADE');
    const db = new DatabaseSync(':memory:');
    db.exec(ddlFor('meetings'));
    db.exec(ddl);
    db.exec(indexDdlFor('idx_marks_meeting'));
  });
});
