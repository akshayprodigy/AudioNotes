// Typed query layer over the Storage TurboModule. Screens/state call these, never raw SQL.
import Storage from '../native/NativeStorage';
import { NO_ANCHOR, USER_GEN } from '../pipeline/types';
import type {
  ActionRow,
  Edit,
  EditTarget,
  Item,
  ItemKind,
  ItemSource,
  Meeting,
  Minute,
  MinuteKind,
  SearchHit,
  Speaker,
  Utterance,
} from '../pipeline/types';

async function run<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const raw = await Storage.query(sql, JSON.stringify(params));
  return JSON.parse(raw) as T[];
}

export type MeetingSort = 'recent' | 'oldest' | 'longest' | 'title';

/**
 * The only orderings the library can ask for, spelled out.
 *
 * A map rather than a string the caller passes through: `sort` comes from a saved setting, which
 * is a row in a database on a phone its owner controls, so it is untrusted input by the time it
 * reaches here.
 *
 * `title` collates case-insensitively because "acme sync" filed away from "Acme sync" is not a
 * sort, it is two lists.
 */
const MEETING_ORDER: Record<MeetingSort, string> = {
  recent: 'created_at DESC',
  oldest: 'created_at ASC',
  longest: 'duration_ms DESC',
  title: 'title COLLATE NOCASE ASC',
};

/**
 * One spelling per tag.
 *
 * Tags are typed, not chosen from a list, so "Client", "client " and "client" would otherwise be
 * three separate filters that each hold part of the answer. Folded to lower case and collapsed,
 * which is the same normalisation the item key uses and for the same reason.
 */
export function normaliseTag(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 32);
}

export const db = {
  init: () => Storage.open(),

  // Columns are aliased to the camelCase the TS types declare. `SELECT *` returned raw snake_case,
  // so meeting.createdAt / .durationMs / .tierUsed were silently undefined everywhere.
  /**
   * The library, ordered and optionally narrowed to one tag.
   *
   * The ORDER BY is built from a closed set rather than interpolated from the caller's string —
   * this is the one query whose shape the UI gets to choose, and a sort key that reached SQL
   * unchecked would be an injection point in a database holding the user's meetings.
   *
   * Filtering by tag is an EXISTS rather than a join so a meeting carrying three tags still
   * appears once; a join would return it three times and the list would show duplicates.
   */
  listMeetings: (sort: MeetingSort = 'recent', tag?: string | null) =>
    run<Meeting>(
      'SELECT id, title, created_at AS createdAt, duration_ms AS durationMs, language, ' +
        'status, tier_used AS tierUsed, audio_retained AS audioRetained, summary_line AS summaryLine, ' +
        'transcribe_forced_at AS transcribeForcedAt, forced_from_language AS forcedFromLanguage, ' +
        'diar_skipped_reason AS diarSkippedReason ' +
        'FROM meetings WHERE archived_at IS NULL' +
        (tag ? ' AND EXISTS(SELECT 1 FROM tags t WHERE t.meeting_id = meetings.id AND t.name = ?)' : '') +
        ` ORDER BY ${MEETING_ORDER[sort] ?? MEETING_ORDER.recent}`,
      tag ? [tag] : [],
    ),

  listArchived: () =>
    run<Meeting>(
      'SELECT id, title, created_at AS createdAt, duration_ms AS durationMs, language, ' +
        'status, tier_used AS tierUsed, audio_retained AS audioRetained, summary_line AS summaryLine, ' +
        'transcribe_forced_at AS transcribeForcedAt, forced_from_language AS forcedFromLanguage, ' +
        'diar_skipped_reason AS diarSkippedReason ' +
        'FROM meetings WHERE archived_at IS NOT NULL ORDER BY archived_at DESC',
    ),

  archivedCount: () =>
    run<{ n: number }>('SELECT COUNT(*) AS n FROM meetings WHERE archived_at IS NOT NULL').then(
      r => r[0]?.n ?? 0,
    ),

  setArchived: (id: string, archived: boolean) =>
    run('UPDATE meetings SET archived_at = ? WHERE id = ?', [archived ? Date.now() : null, id]),

  /**
   * Meetings that captured audio but yielded no transcript — the 3-second mis-taps that
   * accumulate faster than anything else in the library.
   */
  emptyMeetings: () =>
    run<{ id: string }>(
      "SELECT id FROM meetings WHERE status = 'error' AND archived_at IS NULL " +
        'AND id NOT IN (SELECT DISTINCT meeting_id FROM utterances)',
    ),

  /**
   * Remove a meeting and everything derived from it.
   *
   * utterances/speakers/minutes/segments are ON DELETE CASCADE, but `search_fts` is an FTS5
   * virtual table with no foreign key, so its rows survive the cascade — leaving deleted meetings
   * findable in search, linking to a meeting that no longer opens. It is deleted explicitly, and
   * first, so a failure part-way through cannot strand the index against a missing meeting.
   *
   * The caller is responsible for the audio file (see PipelineController.deleteMeeting): it lives
   * on the filesystem, not in the database, and only native can unlink it.
   */
  deleteMeeting: async (id: string) => {
    await run('DELETE FROM search_fts WHERE meeting_id = ?', [id]);
    await run('DELETE FROM meetings WHERE id = ?', [id]);
  },

  getMeeting: (id: string) =>
    run<Meeting>(
      'SELECT id, title, created_at AS createdAt, duration_ms AS durationMs, language, ' +
        'status, tier_used AS tierUsed, audio_retained AS audioRetained, summary_line AS summaryLine, ' +
        'transcribe_forced_at AS transcribeForcedAt, forced_from_language AS forcedFromLanguage, ' +
        'diar_skipped_reason AS diarSkippedReason ' +
        'FROM meetings WHERE id = ?',
      [id],
    ).then(r => r[0]),

  /**
   * Rename a meeting.
   *
   * Stamps `title_edited_at`, which is the only thing standing between a user's title and the
   * pipeline's auto-retitle. That retitle guards itself with a string sniff — "Meeting", or a
   * ` meeting · ` placeholder — so a real title matching the pattern used to be silently
   * overwritten, and not only on an explicit reprocess: the retitle sits outside the resume plan
   * and re-runs on every pass over a meeting that is not yet 'done'.
   *
   * Reindexed explicitly because the FTS table lives on the native side and nothing else here
   * can write it.
   */
  setTitle: async (id: string, title: string) => {
    await run('UPDATE meetings SET title = ?, title_edited_at = ? WHERE id = ?', [
      title,
      Date.now(),
      id,
    ]);
    await Storage.reindex(id);
  },

  utterances: (meetingId: string) =>
    run<Utterance>(
      'SELECT id, meeting_id AS meetingId, start_ms AS startMs, end_ms AS endMs, ' +
        'speaker_id AS speakerId, text FROM utterances WHERE meeting_id = ? ORDER BY start_ms',
      [meetingId],
    ),

  speakers: (meetingId: string) =>
    run<Speaker>(
      'SELECT id, meeting_id AS meetingId, cluster_label AS clusterLabel, ' +
        'display_name AS displayName FROM speakers WHERE meeting_id = ?',
      [meetingId],
    ),

  minutes: (meetingId: string) =>
    run<Minute>(
      'SELECT id, meeting_id AS meetingId, kind, content_json AS content, source ' +
        'FROM minutes WHERE meeting_id = ? ORDER BY rowid',
      [meetingId],
    ),

  /**
   * A meeting's items with their evidence, in the order they were said.
   *
   * Two queries and a group rather than one join, because a join would repeat every item once per
   * source and the screen would have to undo that. The grouping is keyed on the item id: handing
   * every item the same list is the failure this shape has already produced once, on the Kotlin
   * side, where it went unnoticed because only one test read `.sources` at all and its meeting had
   * a single item.
   *
   * Both ORDER BYs are the contract callers read — `anchor_start_ms, rowid` for the items,
   * `ordinal` for each item's evidence — and neither is decorative: evidence read back out of
   * order is the wrong moment shown against a person's item.
   *
   * A meeting recorded before items existed has none here until db.ensureItems has run for it.
   *
   * Read by MeetingScreen, which hands the rows to the MOM and Actions tabs (Task 10). Those tabs
   * still merge in two populations that are not in this table — see toItemRows in
   * src/screens/meeting/shared.tsx, which is the one place that merge is decided.
   *
   * WHAT THIS DELIBERATELY DOES NOT RETURN, and what to do about it. `touched` — whether a person
   * has engaged with an item — is not a column and is not derivable from anything above. It spans
   * four tables (`items.review`, `item_done`, `action_done` for every meeting the migration has
   * not reached, and `edits`), three of which never write to the item row, and AudioDb.items()
   * assembles it at that boundary as the ONE copy of the predicate. A screen that needs it adds
   * the column HERE, next to this SQL and next to that comment, so the two boundaries stay in step
   * — not by OR-ing `review` and a tick at the call site. That reassembly is the mistake this
   * sub-project has now made three times, and not one of the three failed to compile.
   *
   * WHAT IT DOES DERIVE, for exactly that reason: the anchor of a row that never claimed a moment.
   * `anchor_start_ms` is `INTEGER NOT NULL` and a hand-typed row still has to store a number, so
   * the column holds a sentinel (types.ts NO_ANCHOR) and this SELECT turns it into `null` — from
   * `gen_version`, which is the authoritative marker, and never by comparing against the sentinel.
   * It happens HERE, in the SQL, so that no screen, no renderer and no export can be handed a
   * stored anchor that secretly means "none": `toItemRows` copies the field straight through, both
   * tabs gate the provenance button on `anchorStartMs !== null`, and none of them has to know the
   * rule. AudioDb.items and FileExportModule.exportItems are the same derivation on the Kotlin
   * side.
   */
  items: async (meetingId: string): Promise<Item[]> => {
    const rows = await run<Omit<Item, 'sources'>>(
      'SELECT id, meeting_id AS meetingId, kind, text, review, gen_version AS genVersion, ' +
        `CASE WHEN gen_version = '${USER_GEN}' THEN NULL ELSE anchor_start_ms END AS anchorStartMs, ` +
        `CASE WHEN gen_version = '${USER_GEN}' THEN NULL ELSE anchor_end_ms END AS anchorEndMs ` +
        'FROM items WHERE meeting_id = ? ORDER BY anchor_start_ms, rowid',
      [meetingId],
    );
    const srcs = await run<ItemSource & { itemId: string }>(
      'SELECT item_id AS itemId, start_ms AS startMs, end_ms AS endMs, ' +
        'char_start AS charStart, char_end AS charEnd, utterance_id AS utteranceId ' +
        'FROM item_sources WHERE item_id IN (SELECT id FROM items WHERE meeting_id = ?) ' +
        'ORDER BY item_id, ordinal',
      [meetingId],
    );
    const byItem = new Map<string, ItemSource[]>();
    for (const { itemId, ...s } of srcs) {
      const list = byItem.get(itemId);
      if (list) list.push(s);
      else byItem.set(itemId, [s]);
    }
    return rows.map(r => ({ ...r, sources: byItem.get(r.id) ?? [] }));
  },

  /**
   * Replace the RULE-based minutes for a meeting, leaving the LLM prose alone.
   *
   * Scoped to source='rule' deliberately, mirroring AudioDb.replaceMinutes. Deleting every row
   * here is what used to throw away the summary and the narrative whenever a speaker merge
   * rebuilt the items — the rules are extractive and cheap to regenerate, the prose is neither.
   * Row ids are namespaced per source for the same reason: `${meetingId}:rule:${i}` cannot collide
   * with a row Narrator wrote.
   */
  replaceMinutes: async (meetingId: string, mins: { kind: string; content: string; source: string }[]) => {
    await run("DELETE FROM minutes WHERE meeting_id = ? AND source = 'rule'", [meetingId]);
    for (let i = 0; i < mins.length; i++) {
      const m = mins[i];
      await run('INSERT INTO minutes(id, meeting_id, kind, content_json, source) VALUES(?,?,?,?,?)', [
        `${meetingId}:rule:${i}`,
        meetingId,
        m.kind,
        m.content,
        m.source,
      ]);
    }
  },

  /**
   * Drop a meeting's LLM prose, so the next run writes it again.
   *
   * ResumePlan decides what still needs doing from the rows that exist, which is what makes a
   * killed run resumable — but it also means a finished meeting has nothing left to run, and
   * "Redo" on one returned instantly having done nothing at all. Clearing the prose is what turns
   * that button back into an action: narration becomes outstanding work again.
   *
   * Scoped to source='llm', the mirror of replaceMinutes above. The rule-based items are the
   * guaranteed floor and stay put, so the screen never blanks out while the model reruns.
   */
  /**
   * Record that a person overruled the "not English" refusal on this meeting.
   *
   * `heardLanguage` is passed in by the caller rather than read here: the meeting row still holds
   * it at the moment of the tap, and will not once the forced run succeeds and overwrites
   * `language` with the requested code. That is the whole reason it is a separate column.
   */
  markTranscribeForced: async (meetingId: string, heardLanguage: string | null) => {
    await run(
      'UPDATE meetings SET transcribe_forced_at = ?, forced_from_language = ? WHERE id = ?',
      [Date.now(), heardLanguage && heardLanguage.trim() ? heardLanguage : null, meetingId],
    );
  },

  clearNarration: async (meetingId: string) => {
    await run("DELETE FROM minutes WHERE meeting_id = ? AND source = 'llm'", [meetingId]);
    await run('UPDATE meetings SET summary_line = NULL WHERE id = ?', [meetingId]);
  },

  /**
   * Ticked-off actions, keyed by a hash of the item text rather than the minutes row id.
   *
   * Minutes rows are deleted and re-inserted whenever a meeting is reprocessed or its speakers are
   * merged, so a row-id key would silently uncheck everything the user had worked through. Keying
   * on the normalised text means a tick survives anything that does not change the wording.
   *
   * WHAT STILL READS THIS, since Task 10 moved the meeting's Actions tab onto `item_done`. The ONE
   * population that has no item to key on: every row of a meeting whose item migration has not run
   * yet. A row somebody TYPED was the second until Task 12 gave it an item and
   * `AudioDb.carryUserMinutesOntoItems` moved its tick into `item_done` with it. The tab reads both
   * stores and asks each row's own identity which one it lives in — see ActionsTab.tsx. It is also
   * still where every tick lives that a rolled-back build would have to find, which is the other
   * reason none of this is deleted.
   */
  doneActions: async (meetingId: string): Promise<Set<string>> => {
    const rows = await run<{ itemKey: string }>(
      'SELECT item_key AS itemKey FROM action_done WHERE meeting_id = ?',
      [meetingId],
    );
    return new Set(rows.map(r => r.itemKey));
  },

  setActionDone: (meetingId: string, itemKey: string, done: boolean) =>
    done
      ? run('INSERT OR REPLACE INTO action_done(meeting_id, item_key, done_at) VALUES(?,?,?)', [
          meetingId,
          itemKey,
          Date.now(),
        ])
      : run('DELETE FROM action_done WHERE meeting_id = ? AND item_key = ?', [meetingId, itemKey]),

  /**
   * This meeting's ticked item ids.
   *
   * The per-meeting twin of `doneItemIds` below, and the JavaScript mirror of
   * `AudioDb.doneItemIds(meetingId)`, which has had exactly this shape since Task 8 and no caller
   * on this side until the Actions tab moved onto items.
   *
   * Why not the library-wide read the worklist uses: that one returns every tick in the library, a
   * set that grows with the library, flattened into `meetingId\u0000itemId` strings a per-meeting
   * screen would only have to reassemble to ask about the meeting it is already looking at. The
   * worklist wants the wide read because it draws every meeting at once. This does not.
   *
   * NARROWER than the native `touched` predicate for the same reason `doneItemIds` is: it reads
   * `item_done` and nothing else. See the note there.
   */
  doneItems: async (meetingId: string): Promise<Set<string>> => {
    const rows = await run<{ itemId: string }>(
      'SELECT item_id AS itemId FROM item_done WHERE meeting_id = ?',
      [meetingId],
    );
    return new Set(rows.map(r => r.itemId));
  },

  /**
   * Tick or untick one item, keyed on the item's stable id.
   *
   * WHICH STORE THIS IS. `item_done`, not `action_done` — a different table from setActionDone
   * above. Both writers are now here: the cross-meeting worklist (src/screens/ActionsScreen.tsx)
   * and the meeting's own Actions tab (src/screens/meeting/ActionsTab.tsx), which Task 10 moved
   * across. Between Task 9 and Task 10 they were separate stores and a tick made in one did not
   * show in the other; that gap was accepted, recorded, and is closed.
   *
   * What is left in `action_done` is the two populations with no item id to key on — a row
   * somebody typed, and any meeting whose migration has not run — plus every tick a rolled-back
   * build would need to find. Bridging the two by writing BOTH stores would still be wrong:
   * nothing sweeps `action_done` on an untick from elsewhere, so an item unticked here and
   * re-ticked there would come back ticked on the next reprocess, permanently — the same reason
   * AudioDb.ensureItems does not run its tick carry unconditionally.
   */
  setItemDone: (meetingId: string, itemId: string, done: boolean) =>
    done
      ? run('INSERT OR REPLACE INTO item_done(meeting_id, item_id, done_at) VALUES(?,?,?)', [
          meetingId,
          itemId,
          Date.now(),
        ])
      : run('DELETE FROM item_done WHERE meeting_id = ? AND item_id = ?', [meetingId, itemId]),

  setStatus: (meetingId: string, status: string) =>
    run('UPDATE meetings SET status = ? WHERE id = ?', [status, meetingId]),

  /**
   * Meetings that still owe work: captured but never started, OR abandoned part-way through.
   *
   * The intermediate statuses matter as much as 'captured'. Processing a meeting takes tens of
   * minutes, so being killed mid-pipeline is routine rather than exotic — and a row left in
   * 'vad'/'asr'/'diarized' was previously matched by nothing: recoverOrphans() only rescues
   * 'recording', and this query only looked for 'captured'. Such meetings had their audio on
   * disk and were never touched again.
   *
   * A meeting genuinely in progress right now is also in one of these states, so the caller
   * must skip whatever it already has in flight (see PipelineController.processPending).
   */
  pendingMeetings: () =>
    run<{ id: string }>(
      "SELECT id FROM meetings WHERE status IN ('captured','vad','asr','diarized') " +
        'ORDER BY created_at',
    ),

  // Simple key/value settings (onboarding flag, prefs).
  getSetting: (key: string) =>
    run<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]).then(
      r => r[0]?.value ?? null,
    ),
  setSetting: (key: string, value: string) =>
    run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', [key, value]),

  /**
   * Raw query, for the network ledger only.
   *
   * Everything else on this object is a named, typed helper and should stay that way. The ledger
   * is the exception because its table is written from four unrelated places and read by one
   * screen — a dozen bespoke helpers would be worse than one seam that says what it is for.
   */
  query: <T>(sql: string, params: unknown[] = []) => run<T>(sql, params),

  // VAD speech spans — used to show "silence stripped" after milestone-1 processing.
  segments: (meetingId: string) =>
    run<{ start_ms: number; end_ms: number }>(
      'SELECT start_ms, end_ms FROM segments WHERE meeting_id = ? ORDER BY start_ms',
      [meetingId],
    ),

  renameSpeaker: (speakerId: string, name: string) =>
    run('UPDATE speakers SET display_name = ? WHERE id = ?', [name, speakerId]),

  // Merge one speaker into another across all utterances, then drop the merged speaker row.
  mergeSpeakers: async (meetingId: string, keepId: string, dropId: string) => {
    await run('UPDATE utterances SET speaker_id = ? WHERE meeting_id = ? AND speaker_id = ?', [
      keepId,
      meetingId,
      dropId,
    ]);
    await run('DELETE FROM speakers WHERE id = ?', [dropId]);
  },

  /**
   * Ranked full-text search across transcripts, minutes, titles and summaries.
   *
   * Typed deliberately. This used to return `any`, with the screen asserting a local shape over
   * it, so changing the projection produced no compile error anywhere — the results just rendered
   * as `undefined`. The tsc gate now covers the one query it could not see.
   */
  search: (term: string): Promise<SearchHit[]> =>
    Storage.search(term).then(r => JSON.parse(r) as SearchHit[]),

  /** Index meetings recorded before the index covered more than the transcript. Returns the backlog. */
  backfillSearch: (limit = 25) => Storage.backfillSearch(limit),

  /**
   * Give one meeting its items if it was recorded before items existed.
   *
   * Per-meeting, next to the chunked sweep in backfillItems below rather than instead of it: this
   * is what migrates the meeting somebody opened from a notification, before its screen reads it,
   * and the sweep is what migrates the rest of the library for the views that read across
   * meetings. Both go through the same guard on the native side (AudioDb.ensureItems), which is
   * derived from the data plus a per-meeting marker rather than a global flag — so a failed
   * attempt costs nothing but a retry. The caller is the meeting screen's read
   * (MeetingScreen.refresh), which has to await it before reading.
   *
   * It can reject on a phone that has not finished downloading libonnxruntime.so, because the
   * migration re-runs the rule pass through the native core. That is deliberate on the Kotlin side
   * and must never be fatal here: a meeting is readable whether or not it has been migrated yet.
   */
  ensureItems: (meetingId: string) => Storage.ensureItems(meetingId),

  /**
   * Migrate up to `limit` pre-items meetings. Returns how many are still outstanding.
   *
   * The library-wide half of ensureItems above, and the reason both exist is that they serve
   * different readers. A meeting screen can migrate the one meeting being opened; the worklist,
   * the Library's outstanding-actions tally and Search's "meetings with actions" filter all read
   * ACROSS meetings, and under the lazy trigger alone they describe the meetings somebody has
   * opened since updating rather than the library — reporting "nothing outstanding" to a person
   * with a fortnight of unticked actions.
   *
   * Driven by libraryStore.backfillItems, which is where the batching, the latch and the retry
   * policy live. Same rejection behaviour as ensureItems, and never fatal for the same reason.
   */
  backfillItems: (limit = 25) => Storage.backfillItems(limit),

  // ---- Tags -------------------------------------------------------------------------------

  tagsFor: (meetingId: string) =>
    run<{ name: string }>('SELECT name FROM tags WHERE meeting_id = ? ORDER BY name', [
      meetingId,
    ]).then(rows => rows.map(r => r.name)),

  /** Every tag in use, most-used first, so the library's filter row leads with the useful ones. */
  allTags: () =>
    run<{ name: string; n: number }>(
      'SELECT name, COUNT(*) AS n FROM tags GROUP BY name ORDER BY n DESC, name ASC',
    ),

  addTag: async (meetingId: string, name: string) => {
    const clean = normaliseTag(name);
    if (!clean) return;
    await run('INSERT OR IGNORE INTO tags(meeting_id, name) VALUES(?,?)', [meetingId, clean]);
  },

  removeTag: (meetingId: string, name: string) =>
    run('DELETE FROM tags WHERE meeting_id = ? AND name = ?', [meetingId, name]),

  // ---- User edits of pipeline-written text ------------------------------------------------

  edits: (meetingId: string) =>
    run<Edit>(
      'SELECT meeting_id AS meetingId, target_kind AS targetKind, target_key AS targetKey, ' +
        'content, edited_at AS editedAt FROM edits WHERE meeting_id = ?',
      [meetingId],
    ),

  /**
   * Save an edit as a SIDE row rather than an update of the text being edited.
   *
   * Ticked actions are keyed on a hash of the stored minute text, so rewriting that text in place
   * would untick every item the user had worked through — the one promise the worklist makes.
   * Leaving the original untouched keeps the tick key stable, lets reprocessing overwrite what it
   * owns, and makes "revert" a single delete.
   */
  putEdit: async (meetingId: string, targetKind: EditTarget, targetKey: string, content: string) => {
    await run(
      'INSERT OR REPLACE INTO edits(meeting_id, target_kind, target_key, content, edited_at) ' +
        'VALUES(?,?,?,?,?)',
      [meetingId, targetKind, targetKey, content, Date.now()],
    );
    await Storage.reindex(meetingId);
  },

  clearEdit: async (meetingId: string, targetKind: EditTarget, targetKey: string) => {
    await run('DELETE FROM edits WHERE meeting_id = ? AND target_kind = ? AND target_key = ?', [
      meetingId,
      targetKind,
      targetKey,
    ]);
    await Storage.reindex(meetingId);
  },

  // ---- Hand-written items and prose -----------------------------------------------------------

  /**
   * A decision, an action or an open question a person typed themselves.
   *
   * IT IS AN `items` ROW, not a `minutes` row, and that is the whole of Task 12. It keeps the
   * property the old user-minute rows were given deliberately — one table, so every kind-based
   * filter picks it up and it exports and backs up for free — and gains the three a `minutes` row
   * could never have: a stable id, so its tick lives in `item_done` and its correction in `edits`
   * keyed on that id and both survive the wording changing under them; a row in the CROSS-MEETING
   * worklist, which reads `items` and so has never shown a hand-typed action at all; and one
   * renderer on the tabs and in the export instead of a merge of two tables.
   *
   * `review = 'confirmed'` is true by construction — a person wrote it, there is nothing to
   * review. `gen_version = 'user'` is the marker everything else keys on: Reconciler rule 1 sets
   * the row aside before matching, so a reprocess can neither consume it, re-word it nor flag it.
   *
   * IT CITES NOTHING, and the UI must not offer it a provenance button. An item with no sources is
   * not a failure to find evidence; it is an item that never claimed any. That is also why its
   * anchor is NO_ANCHOR rather than 0 — see the constant, and db.items, which is where the
   * sentinel becomes the `null` every reader actually sees.
   */
  addUserItem: async (meetingId: string, kind: ItemKind, text: string): Promise<Item> => {
    // The id shape addUserMinute already used, random suffix included: two actions typed in one
    // sitting can land in the same millisecond, and a bare Date.now() id collides on the primary
    // key. The `:user:` segment is a convenience for anybody reading rows by hand — nothing parses
    // it, and `gen_version` is what every decision is made on.
    const id = `${meetingId}:user:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
    const createdAt = Date.now();
    await run(
      'INSERT INTO items(id, meeting_id, kind, text, review, gen_version, ' +
        'anchor_start_ms, anchor_end_ms, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [id, meetingId, kind, text, 'confirmed', USER_GEN, NO_ANCHOR, NO_ANCHOR, createdAt],
    );
    // Searchable the moment it is typed, exactly as a hand-typed `minutes` row has always been.
    // AudioDb.indexItems is what decides where a hit on it opens the meeting — at the top, like
    // every other row with no moment, and not at the sentinel.
    await Storage.reindex(meetingId);
    return {
      id,
      meetingId,
      kind,
      text,
      review: 'confirmed',
      genVersion: USER_GEN,
      // What db.items would hand back for this row, so a caller that uses the return value and one
      // that re-reads see the same thing. Never the sentinel: that number exists only on disk.
      anchorStartMs: null,
      anchorEndMs: null,
      sources: [],
    };
  },

  /**
   * Remove an item a person typed. Never an extracted one.
   *
   * The `gen_version` clause is the safety of this statement rather than a formality. An id
   * arriving from a screen that had drawn a stale list would otherwise delete an extracted item
   * outright — and a reprocess would bring the sentence back without its tick and without the
   * person's correction, because both are keyed on the id this deleted.
   *
   * `item_done` and `edits` rows keyed on the id are left behind, as they are everywhere else in
   * this schema: `item_done` has no foreign key to `items` on purpose (a cascade there would wipe
   * every tick on every reprocess) and `edits` has none either. Both are orphaned by an id that
   * will never be minted again, and `replaceItems` sweeps orphaned ticks on the next reprocess.
   */
  removeUserItem: async (meetingId: string, id: string) => {
    await run(`DELETE FROM items WHERE id = ? AND gen_version = '${USER_GEN}'`, [id]);
    await Storage.reindex(meetingId);
  },

  /**
   * Add a piece of PROSE the meeting never produced — a summary, a write-up, a headline.
   *
   * Written into `minutes` with source='user'. The item kinds moved to [addUserItem] in Task 12;
   * these three stay because they are documents rather than list rows — there is one of each per
   * meeting, they have no anchor, no tick and no provenance, and `items` has nothing to offer
   * them. `replaceMinutes` deletes only source='rule', so reprocessing cannot take them away.
   */
  addUserMinute: async (meetingId: string, kind: MinuteKind, content: string) => {
    // MINUTE_SOURCE_USER below, never USER_GEN: `minutes.source` and `items.gen_version` are two
    // vocabularies that agree on this one spelling by coincidence. See the constant.
    const id = `${meetingId}:user:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
    await run('INSERT INTO minutes(id, meeting_id, kind, content_json, source) VALUES(?,?,?,?,?)', [
      id,
      meetingId,
      kind,
      // Plain text, NOT JSON.stringify. Despite the column name, `content_json` holds a bare
      // string everywhere else — the native minutes writer, replaceMinutes and the export
      // renderer all read it that way — so encoding here put literal quotation marks around
      // every hand-written item, in the app and in the exported document.
      content,
      'user',
    ]);
    await Storage.reindex(meetingId);
    return id;
  },

  deleteUserMinute: async (meetingId: string, id: string) => {
    await run("DELETE FROM minutes WHERE id = ? AND source = 'user'", [id]);
    await Storage.reindex(meetingId);
  },

  // ---- Cross-meeting worklist --------------------------------------------------------------

  /**
   * Every action item across every live meeting, newest meeting first, with its identity.
   *
   * Reads `items`, not `minutes`. Those hold the same sentences for now — `replaceMinutes` still
   * writes the item kinds, because a meeting nobody has opened has not been migrated and its
   * `minutes` rows are all it has — and the worklist reads the one that carries an id a tick can
   * be keyed on.
   *
   * THIS IS A CROSS-MEETING READ, which is what forced the sweep. Task 8 migrated a meeting only
   * when somebody OPENED it and rejected a library-wide pass as over-building; under that, the
   * first run of this build returned only the meetings opened since updating — so a person with a
   * fortnight of unticked actions was told, by the one list whose whole job is to be believed,
   * that they had none. A gap that states a number is not a gap. libraryStore.backfillItems now
   * drains the backlog on a Library focus (db.backfillItems), and the Library's tally and Search's
   * "meetings with actions" filter heal on the same pass. Nothing was lost while it did not: the
   * `minutes` rows and every `action_done` tick stayed exactly where they were, and a meeting's own
   * Actions tab still reads both.
   *
   * AS OF TASK 12 IT FINALLY SHOWS HAND-TYPED ACTIONS. One a person typed used to be a `minutes`
   * row with no item, so it appeared on that meeting's own Actions tab and nowhere else — the one
   * list whose whole job is to say what you owe left it out, on every meeting, migrated or not.
   *
   * `items` has no `source` column; `gen_version` records what wrote the row, and USER_GEN is what
   * `db.addUserItem` writes there. Archived meetings are excluded because they are hidden from
   * the library, and their actions resurfacing in a worklist is what would make archiving useless.
   *
   * Rejected items are excluded for a reason that has not happened yet, which is exactly why the
   * clause is here now. Nothing writes `review='rejected'` today, and `Reconciler` rule 4 keeps a
   * rejected row in `items` FOREVER once something does — "keeping the no is what makes it stick"
   * — so the day a reject gesture ships, every dismissed action would return as outstanding work
   * with nothing failing to compile. A rejected action is by definition not outstanding.
   *
   * `done` is still resolved by the caller (src/screens/actionsData.ts) rather than joined here —
   * see doneItemIds below for the reason, which is no longer that SQL cannot reproduce the key.
   *
   * SECOND CALLER, and it does not want the ticks: SearchScreen's "only meetings with actions"
   * filter reads this for the meeting ids alone. Reading `items` narrows that filter to meetings
   * the migration has reached, so a meeting nobody has opened since updating drops out of it until
   * they do. It heals one meeting at a time, on the same trigger everything else here does.
   */
  allActions: () =>
    run<Omit<ActionRow, 'done'>>(
      'SELECT i.id AS id, i.meeting_id AS meetingId, mt.title AS meetingTitle, ' +
        'mt.created_at AS createdAt, i.text AS content, ' +
        // The same derivation db.items makes, for the same reason: a hand-typed action has no
        // moment, and `ActionRow.anchorStartMs` is what the "take me to where this was said"
        // gesture will read. Handing it the sentinel would send somebody 285,000 years into a
        // recording; handing it 0 would send them to the top of one for a sentence nobody spoke.
        `CASE WHEN i.gen_version = '${USER_GEN}' THEN NULL ELSE i.anchor_start_ms END ` +
        'AS anchorStartMs, ' +
        // Spelled from the shared constant now rather than inline, which is what Task 9's review
        // flagged. The ELSE is still lossy: if a VERSIONED user gen is ever wanted — `user@1`, the
        // convention `rules@1` already sets — this line would silently report every hand-typed
        // action as 'rule', and Reconciler rule 1's `genVersion != Gen.USER` would stop protecting
        // it at the same moment. The two change together or not at all.
        `CASE WHEN i.gen_version = '${USER_GEN}' THEN 'user' ELSE 'rule' END AS source ` +
        'FROM items i JOIN meetings mt ON mt.id = i.meeting_id ' +
        "WHERE i.kind = 'action' AND i.review <> 'rejected' AND mt.archived_at IS NULL " +
        // meeting_id is in here for the grouper, not for the eye: ActionsScreen.group() is a
        // RUN-LENGTH grouper, so a meeting whose rows are interrupted by another's emits two
        // headers with the count split between them. Two meetings created in the same millisecond
        // — an import, a restore, two taps — would interleave DETERMINISTICALLY without it, not
        // rarely, because every meeting's anchors start near 0. Identical output whenever
        // created_at is distinct, which is every other case.
        'ORDER BY mt.created_at DESC, i.meeting_id, i.anchor_start_ms, i.rowid',
    ),

  /**
   * Every ticked item in the library, as `meetingId\u0000itemId`.
   *
   * The id is what makes this safe to key on. `doneKeys` below is keyed on a hash of the item's
   * TEXT, so re-recognising one word unticked it; `Reconciler` (pipeline/Reconciler.kt) carries an
   * item's id across a reprocess and flags rather than guesses when it is unsure, which is the
   * thing that hash was standing in for.
   *
   * The pair is flattened into one string because a Set of tuples cannot be looked up by value.
   * The separator is a NUL for the same reason it is in `doneKeys` — it cannot occur in either
   * half, and any character that can lets one meeting's tick land on another meeting's item.
   *
   * NARROWER than the native `touched` predicate, deliberately: this reads `item_done` and nothing
   * else, so a meeting whose ticks are still in `action_done` because ensureItems' guard never
   * fired for it (see AudioDb.ensureItems) draws its items unticked here while still being fully
   * protected from deletion there.
   */
  doneItemIds: async (): Promise<Set<string>> => {
    const rows = await run<{ meetingId: string; itemId: string }>(
      'SELECT meeting_id AS meetingId, item_id AS itemId FROM item_done',
    );
    return new Set(rows.map(r => `${r.meetingId}\u0000${r.itemId}`));
  },

  /**
   * Every ticked action key in the library, as `meetingId\u0000itemKey`.
   *
   * STILL NO CALLER. The worklist reads doneItemIds; the per-meeting Actions tab reads `doneItems`
   * for its items and `doneActions` for the rows that have none. Task 10 was named as the point at
   * which this could go, and it was left in place on purpose: `action_done` is not empty and is
   * not emptied — it holds every tick of every hand-typed row, every unmigrated meeting, and the
   * rollback path — and this is the only library-wide way to see them. Deleting a dead READ of a
   * live table is a different job from moving a screen, and it should be argued on the table's
   * lifetime rather than smuggled into a screen commit.
   */
  doneKeys: async (): Promise<Set<string>> => {
    const rows = await run<{ meetingId: string; itemKey: string }>(
      'SELECT meeting_id AS meetingId, item_key AS itemKey FROM action_done',
    );
    return new Set(rows.map(r => `${r.meetingId}\u0000${r.itemKey}`));
  },
};
