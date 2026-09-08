import { SCHEMA } from '../schema';

/**
 * Column-level pins for the three evidence-spine tables (items, item_sources, item_done) in the
 * READABLE MIRROR, src/db/schema.ts. AudioDb.kt is the schema that actually runs; this file exists
 * only because it is kept in step "by hand" per its own header comment, and hand-keeping has
 * already drifted once (asr_cache, edits, tags and search_fts exist in AudioDb.kt and not here;
 * this file still has the meetings_fts that AudioDb.kt replaced). These tests do not stop the two
 * files drifting from EACH OTHER — nothing here reads AudioDb.kt — they only stop this file
 * drifting internally, silently, the way the assertions below were shown to catch.
 */

/**
 * The single `CREATE TABLE IF NOT EXISTS <table> (...)` statement for `table`, scoped away from
 * the rest of SCHEMA. A plain substring check against the whole joined schema would let `text` or
 * `meeting_id` pass because a NEIGHBOURING table has that column — a test that cannot fail on the
 * thing it claims to check.
 */
function ddlFor(table: string): string {
  const stmt = SCHEMA.find(s => s.trimStart().startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`));
  if (!stmt) throw new Error(`no CREATE TABLE IF NOT EXISTS ${table} in SCHEMA`);
  return stmt;
}

/**
 * Column names out of a CREATE TABLE statement. Strips trailing `-- comment` text first (this
 * file's comments contain commas of their own, e.g. "hidden, restorable", which would otherwise
 * be misread as column separators), then splits on top-level commas only — depth tracked through
 * parentheses — so `REFERENCES meetings(id)` and a table-level `PRIMARY KEY (a, b)` are not
 * mistaken for column boundaries. Deliberately NOT one-column-per-line: a column added onto an
 * existing line is exactly the kind of change this must still catch, and a mutation test proved
 * a line-based version misses it (see the Kotlin SchemaTest for the same finding).
 */
function columnsOf(ddl: string): string[] {
  const noComments = ddl.replace(/--[^\n]*/g, '');
  const body = noComments.slice(noComments.indexOf('(') + 1, noComments.lastIndexOf(')'));
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const c of body) {
    if (c === '(') {
      depth++;
      current += c;
    } else if (c === ')') {
      depth--;
      current += c;
    } else if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current.trim()) parts.push(current);
  return parts
    .map(s => s.trim())
    .filter(s => s.length > 0 && !/^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK|CONSTRAINT)/.test(s))
    .map(s => s.split(/\s+/)[0]);
}

describe('schema.ts evidence tables', () => {
  /**
   * All fourteen columns, including the five Phase B leaves NULL (item_type, status, owner_json,
   * date_said, date_norm). Those exist now specifically so the classifier lands as a write rather
   * than a migration — nothing reads them yet, so nothing else would notice one being dropped.
   */
  it('items has the expected columns', () => {
    const expected = [
      'id', 'meeting_id', 'kind', 'item_type', 'status', 'text', 'owner_json',
      'date_said', 'date_norm', 'review', 'gen_version', 'anchor_start_ms',
      'anchor_end_ms', 'created_at',
    ];
    const actual = columnsOf(ddlFor('items'));
    expect(actual).toEqual(expect.arrayContaining(expected));
    expect(actual).toHaveLength(expected.length); // catches an extra column too
  });

  /**
   * start_ms/end_ms/char_start/char_end are the anchor and the identity; utterance_id and
   * ordinal ride along. Losing any offset column would silently degrade the evidence to
   * utterance-id-only — the identity that does NOT survive a re-ASR.
   */
  it('item_sources has the expected columns', () => {
    const expected = [
      'item_id', 'ordinal', 'start_ms', 'end_ms', 'char_start', 'char_end', 'utterance_id',
    ];
    const actual = columnsOf(ddlFor('item_sources'));
    expect(actual).toEqual(expect.arrayContaining(expected));
    expect(actual).toHaveLength(expected.length);
  });

  it('item_done has the expected columns', () => {
    const expected = ['meeting_id', 'item_id', 'done_at'];
    const actual = columnsOf(ddlFor('item_done'));
    expect(actual).toEqual(expect.arrayContaining(expected));
    expect(actual).toHaveLength(expected.length);
  });

  /**
   * item_done exists to replace action_done's item_key (a hash of the item's text) with a
   * stable id, because re-recognising a single word changes the hash and silently unticks a
   * confirmed item. item_done sits right next to action_done in this file and is otherwise
   * near-identical in shape — exactly the condition under which a column gets copy-pasted back
   * in without anyone noticing. This pins the design decision the table exists for, not a
   * spelling.
   */
  it('item_done does not reintroduce action_done\'s text-hash key', () => {
    expect(columnsOf(ddlFor('item_done'))).not.toContain('item_key');
  });

  it('both new indexes are declared', () => {
    expect(SCHEMA.some(s => s.includes('idx_items_meeting'))).toBe(true);
    expect(SCHEMA.some(s => s.includes('idx_item_sources_start'))).toBe(true);
  });
});
