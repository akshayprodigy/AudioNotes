import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../schema';
import { NO_ANCHOR, USER_GEN } from '../../pipeline/types';

/**
 * Items a person typed themselves, written to and read back out of a real SQLite database.
 *
 * THE WHOLE TASK IS A MOVE BETWEEN TWO TABLES, so a test that mocked the result set would prove
 * only that the mock was written to match the assertion. These run the real statements from
 * `queries.ts` through `node:sqlite`, exactly as worklist.test.ts does, with the same caveat:
 * src/db/schema.ts is the READABLE copy of the DDL and `AudioDb.SCHEMA` is the one that runs.
 *
 * WHAT A HAND-TYPED ROW HAS TO SURVIVE, and why each assertion below is here rather than being
 * obvious. `items.anchor_start_ms` is `INTEGER NOT NULL` and SQLite cannot make a column nullable
 * without rebuilding the table, so a row that never claimed a moment still has to store a number.
 * Storing `0` would print `[0:00]` on an exported document and send a reader to the top of the
 * recording to look for a sentence nobody spoke — and, because every read of `items` is
 * `ORDER BY anchor_start_ms, rowid`, it would also silently move every hand-typed row to the TOP
 * of the MOM, which is not where it has ever been. So the column holds [NO_ANCHOR] and the fact
 * that means "none" is derived at this boundary from `gen_version`, never from the number.
 *
 * FIXTURES HERE HAVE TWO ROWS WHEREVER ORDER OR SELECTION IS ASSERTED, and they are arranged
 * adversarially: the hand-typed row is inserted FIRST and its text sorts FIRST alphabetically, so
 * a fixture cannot pass by accident under insertion order, under text order, or under the old
 * `anchor_start_ms = 0`.
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
  },
}));

// Imported after the mock so the module under test binds to the SQLite-backed stand-in.
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

function meeting(id: string, title: string, createdAt: number, archivedAt: number | null = null) {
  mockSqlite
    .prepare(
      'INSERT INTO meetings(id, title, created_at, duration_ms, status, archived_at) ' +
        "VALUES(?,?,?,0,'done',?)",
    )
    .run(id, title, createdAt, archivedAt);
}

/** An item the RULES produced, with a real moment behind it. */
function ruleItem(id: string, meetingId: string, kind: string, text: string, anchorStartMs: number) {
  mockSqlite
    .prepare(
      'INSERT INTO items(id, meeting_id, kind, text, review, gen_version, anchor_start_ms, ' +
        "anchor_end_ms, created_at) VALUES(?,?,?,?,'suggested','rules@1',?,?,0)",
    )
    .run(id, meetingId, kind, text, anchorStartMs, anchorStartMs + 1000);
}

function storedAnchors(id: string): { start: number; end: number } {
  const row = mockSqlite
    .prepare('SELECT anchor_start_ms AS start, anchor_end_ms AS end FROM items WHERE id = ?')
    .get(id) as unknown as { start: number; end: number };
  return row;
}

beforeEach(() => {
  mockSqlite = new DatabaseSync(':memory:');
  mockSqlite.exec('PRAGMA foreign_keys = ON;');
  for (const t of ['meetings', 'items', 'idx_items_meeting', 'item_sources', 'minutes']) {
    mockSqlite.exec(ddlFor(t));
  }
  (Storage.reindex as jest.Mock).mockClear();
});

afterEach(() => mockSqlite.close());

describe('addUserItem', () => {
  /**
   * A person wrote it, so there is nothing to review and nothing to cite.
   *
   * `review = 'confirmed'` is true by construction rather than a default anybody set, and
   * `gen_version = 'user'` is the ONE marker everything downstream keys on: Reconciler rule 1
   * refuses to match, replace or flag the row, `db.items` refuses it an anchor, and the export
   * refuses it a timestamp. Spelled from the shared constant on purpose — see USER_GEN.
   */
  it('is confirmed on arrival, cites nothing, and is marked as the person who wrote it', async () => {
    meeting('m1', 'Standup', 1000);

    const row = await db.addUserItem('m1', 'action', 'Book the venue — Priya');

    expect(row.review).toBe('confirmed');
    expect(row.sources).toEqual([]);
    expect(row.genVersion).toBe(USER_GEN);
    expect(row.kind).toBe('action');
    expect(row.text).toBe('Book the venue — Priya');
    expect(row.meetingId).toBe('m1');
    // The RETURNED row is what db.items would hand back, never what is on disk. Returning the
    // sentinel here survived every other assertion in this file: the return type is `Item`, whose
    // `anchorStartMs` is what a provenance button is gated on, so a caller that used it instead of
    // re-reading would draw a button offering to play a moment nobody spoke.
    expect(row.anchorStartMs).toBeNull();
    expect(row.anchorEndMs).toBeNull();
    // Searchable the moment it is typed, exactly as a hand-typed `minutes` row was.
    expect(Storage.reindex).toHaveBeenCalledWith('m1');
  });

  /**
   * The row it returns is the row it wrote. A method that returns a hand-built object the
   * database never saw is a method whose INSERT can be wrong in any way at all and still pass.
   */
  it('returns the row that is actually on disk', async () => {
    meeting('m1', 'Standup', 1000);
    ruleItem('i-rule', 'm1', 'action', 'Send the report — Unassigned', 65_000);

    const row = await db.addUserItem('m1', 'decision', 'Ship on the 14th');
    const back = (await db.items('m1')).find(i => i.id === row.id);

    expect(back).toBeDefined();
    expect(back!.kind).toBe('decision');
    expect(back!.text).toBe('Ship on the 14th');
    expect(back!.review).toBe('confirmed');
    expect(back!.genVersion).toBe(USER_GEN);
  });

  /**
   * Two typed in the same millisecond are two rows.
   *
   * `addUserMinute` already carries a random suffix for this reason; a bare `Date.now()` id makes
   * the second INSERT collide on the primary key, and a person adding two actions in one sitting
   * would see an error or lose one. Jest's clock is fast enough that this is not hypothetical.
   */
  it('mints a distinct id for two items typed in the same millisecond', async () => {
    meeting('m1', 'Standup', 1000);

    const a = await db.addUserItem('m1', 'action', 'Ring the supplier');
    const b = await db.addUserItem('m1', 'action', 'Book the venue');

    expect(a.id).not.toBe(b.id);
    expect((await db.items('m1')).map(i => i.text)).toEqual([
      'Ring the supplier',
      'Book the venue',
    ]);
  });
});

describe('the anchor of a row that never claimed a moment', () => {
  /**
   * The stored number is a sentinel, and the boundary turns it into `null`.
   *
   * Both halves matter and they fail differently. If the column held `0`, this assertion would
   * read `0` back and every renderer would print `[0:00]`. If the boundary forgot to map, the
   * screen would be handed 9007199254740991 and the provenance button — gated on
   * `anchorStartMs !== null` — would appear on a row with nothing to show.
   */
  it('stores a sentinel above every real anchor and hands back null', async () => {
    meeting('m1', 'Standup', 1000);
    ruleItem('i-rule', 'm1', 'action', 'Send the report — Unassigned', 65_000);

    const typed = await db.addUserItem('m1', 'action', 'Book the venue — Priya');

    expect(storedAnchors(typed.id)).toEqual({ start: NO_ANCHOR, end: NO_ANCHOR });
    const rows = await db.items('m1');
    expect(rows.find(i => i.id === typed.id)!.anchorStartMs).toBeNull();
    expect(rows.find(i => i.id === typed.id)!.anchorEndMs).toBeNull();
    // The extracted row keeps its own moment: a boundary that nulled EVERY anchor would pass an
    // assertion that only looked at the typed row.
    expect(rows.find(i => i.id === 'i-rule')!.anchorStartMs).toBe(65_000);
  });

  /**
   * The sentinel survives the bridge exactly.
   *
   * Every parameter crosses to Kotlin as JSON and comes back the same way, so a sentinel above
   * 2^53 would arrive rounded — `Long.MAX_VALUE` becomes 9223372036854775808, which SQLite stores
   * as a REAL in an INTEGER column. That is why the value is `Number.MAX_SAFE_INTEGER` rather
   * than the largest number the column could hold.
   */
  it('is exactly representable in JavaScript', async () => {
    meeting('m1', 'Standup', 1000);

    const typed = await db.addUserItem('m1', 'decision', 'Ship on the 14th');

    expect(NO_ANCHOR).toBe(Number.MAX_SAFE_INTEGER);
    expect(storedAnchors(typed.id).start).toBe(NO_ANCHOR);
    expect(Number.isSafeInteger(storedAnchors(typed.id).start)).toBe(true);
  });
});

describe('where a hand-typed row sits in the list', () => {
  /**
   * Last, which is where it has always been, and deliberately.
   *
   * Before this task a typed row lived in `minutes` and `toItemRows` appended it after every item,
   * so it came last no matter what. Moving it into `items` puts it under
   * `ORDER BY anchor_start_ms, rowid` for the first time, and `anchor_start_ms = 0` — the value
   * the plan's listing gives — would put it FIRST in every meeting, silently reversing Task 10's
   * deterministic order.
   *
   * The fixture is arranged so nothing else can produce this answer: the typed row is inserted
   * first, and "Book" sorts before "Send".
   */
  it('after every extracted row, however early it was typed', async () => {
    meeting('m1', 'Standup', 1000);

    const typed = await db.addUserItem('m1', 'action', 'Book the venue — Priya');
    ruleItem('i-late', 'm1', 'action', 'Send the report — Unassigned', 3_600_000);
    ruleItem('i-early', 'm1', 'decision', 'Ship on the 14th', 5_000);

    expect((await db.items('m1')).map(i => i.id)).toEqual(['i-early', 'i-late', typed.id]);
  });

  /** Two typed rows keep the order they were typed in, which is the only order they have. */
  it('and two typed rows keep the order they were typed in', async () => {
    meeting('m1', 'Standup', 1000);

    const first = await db.addUserItem('m1', 'action', 'Ring the supplier');
    const second = await db.addUserItem('m1', 'action', 'Book the venue');

    expect((await db.items('m1')).map(i => i.id)).toEqual([first.id, second.id]);
  });
});

describe('removeUserItem', () => {
  /**
   * Only ever the person's own row.
   *
   * The `gen_version` clause is the whole safety of this statement: an id arriving from a screen
   * that had drawn a stale list would otherwise delete an extracted item outright, and
   * `replaceItems` would not bring it back — the rules would, without its tick or its correction.
   */
  it('removes the row a person typed and refuses an extracted one', async () => {
    meeting('m1', 'Standup', 1000);
    ruleItem('i-rule', 'm1', 'action', 'Send the report — Unassigned', 65_000);
    const typed = await db.addUserItem('m1', 'action', 'Book the venue — Priya');

    await db.removeUserItem('m1', 'i-rule');
    expect((await db.items('m1')).map(i => i.id)).toEqual(['i-rule', typed.id]);

    await db.removeUserItem('m1', typed.id);
    expect((await db.items('m1')).map(i => i.id)).toEqual(['i-rule']);
  });

  /** The list it disappears from is also the index it disappears from. */
  it('reindexes the meeting', async () => {
    meeting('m1', 'Standup', 1000);
    const typed = await db.addUserItem('m1', 'action', 'Book the venue — Priya');
    (Storage.reindex as jest.Mock).mockClear();

    await db.removeUserItem('m1', typed.id);

    expect(Storage.reindex).toHaveBeenCalledWith('m1');
  });
});

describe('allActions', () => {
  /**
   * The cross-meeting worklist finally shows a hand-typed action — and shows it as one.
   *
   * Until this task an action somebody typed into a meeting was a `minutes` row with no item, so
   * it appeared on that meeting's own Actions tab and NOWHERE else: the one list whose job is to
   * say what you owe left it out. The anchor is null here for the same reason it is null in
   * `db.items`: `ActionRow.anchorStartMs` is what a future "take me to the moment" gesture reads,
   * and a hand-typed row has no moment to take anybody to.
   */
  it('includes a hand-typed action, marked as the person`s and with no moment', async () => {
    meeting('m1', 'Standup', 1000);
    ruleItem('i-rule', 'm1', 'action', 'Send the report — Unassigned', 65_000);
    const typed = await db.addUserItem('m1', 'action', 'Book the venue — Priya');

    const rows = await db.allActions();

    expect(rows.map(r => r.id)).toEqual(['i-rule', typed.id]);
    expect(rows[0]).toMatchObject({ source: 'rule', anchorStartMs: 65_000 });
    expect(rows[1]).toMatchObject({ source: 'user', anchorStartMs: null });
  });

  /** A typed DECISION is not an action, and the kind filter is what keeps it off the worklist. */
  it('leaves a hand-typed decision out', async () => {
    meeting('m1', 'Standup', 1000);
    ruleItem('i-rule', 'm1', 'action', 'Send the report — Unassigned', 65_000);
    await db.addUserItem('m1', 'decision', 'Ship on the 14th');

    expect((await db.allActions()).map(r => r.id)).toEqual(['i-rule']);
  });
});
