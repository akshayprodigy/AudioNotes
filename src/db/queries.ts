// Typed query layer over the Storage TurboModule. Screens/state call these, never raw SQL.
import Storage from '../native/NativeStorage';
import type {
  ActionRow,
  Edit,
  EditTarget,
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
        'status, tier_used AS tierUsed, audio_retained AS audioRetained, summary_line AS summaryLine ' +
        'FROM meetings WHERE archived_at IS NULL' +
        (tag ? ' AND EXISTS(SELECT 1 FROM tags t WHERE t.meeting_id = meetings.id AND t.name = ?)' : '') +
        ` ORDER BY ${MEETING_ORDER[sort] ?? MEETING_ORDER.recent}`,
      tag ? [tag] : [],
    ),

  listArchived: () =>
    run<Meeting>(
      'SELECT id, title, created_at AS createdAt, duration_ms AS durationMs, language, ' +
        'status, tier_used AS tierUsed, audio_retained AS audioRetained, summary_line AS summaryLine ' +
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
        'status, tier_used AS tierUsed, audio_retained AS audioRetained, summary_line AS summaryLine ' +
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

  // ---- Hand-written minutes ---------------------------------------------------------------

  /**
   * Add an item the meeting never produced — the action the model missed.
   *
   * Written into `minutes` with source='user'. Every filter in the app selects on `kind`, so the
   * row simply appears alongside the extracted ones; and `replaceMinutes` deletes only
   * source='rule', so reprocessing cannot take it away.
   */
  addUserMinute: async (meetingId: string, kind: MinuteKind, content: string) => {
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
   * Every action item across every live meeting, newest meeting first, with its tick state.
   *
   * The join is on `action_done`, whose key is a hash of the item text computed in JS
   * (ActionsTab.itemKey) — SQL cannot reproduce that hash, so `done` is resolved by the caller
   * from `doneKeys` below rather than here. Archived meetings are excluded: they are hidden from
   * the library and their actions should not resurface in a worklist.
   */
  allActions: () =>
    run<Omit<ActionRow, 'itemKey' | 'done'>>(
      'SELECT m.meeting_id AS meetingId, mt.title AS meetingTitle, mt.created_at AS createdAt, ' +
        'm.content_json AS content, m.source AS source ' +
        'FROM minutes m JOIN meetings mt ON mt.id = m.meeting_id ' +
        "WHERE m.kind = 'action' AND mt.archived_at IS NULL " +
        'ORDER BY mt.created_at DESC, m.rowid',
    ),

  /** Every ticked action key in the library, as `meetingId\u0000itemKey`. */
  doneKeys: async (): Promise<Set<string>> => {
    const rows = await run<{ meetingId: string; itemKey: string }>(
      'SELECT meeting_id AS meetingId, item_key AS itemKey FROM action_done',
    );
    return new Set(rows.map(r => `${r.meetingId}\u0000${r.itemKey}`));
  },
};
