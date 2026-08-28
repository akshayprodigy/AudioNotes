// Typed query layer over the Storage TurboModule. Screens/state call these, never raw SQL.
import Storage from '../native/NativeStorage';
import type { Meeting, Utterance, Minute, Speaker } from '../pipeline/types';

async function run<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const raw = await Storage.query(sql, JSON.stringify(params));
  return JSON.parse(raw) as T[];
}

export const db = {
  init: () => Storage.open(),

  // Columns are aliased to the camelCase the TS types declare. `SELECT *` returned raw snake_case,
  // so meeting.createdAt / .durationMs / .tierUsed were silently undefined everywhere.
  listMeetings: () =>
    run<Meeting>(
      'SELECT id, title, created_at AS createdAt, duration_ms AS durationMs, language, ' +
        'status, tier_used AS tierUsed, audio_retained AS audioRetained, summary_line AS summaryLine ' +
        'FROM meetings WHERE archived_at IS NULL ORDER BY created_at DESC',
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
   * utterances/speakers/minutes/segments are ON DELETE CASCADE, but `meetings_fts` is an FTS5
   * virtual table with no foreign key, so its rows survive the cascade — leaving deleted meetings
   * findable in search, linking to a meeting that no longer opens. It is deleted explicitly, and
   * first, so a failure part-way through cannot strand the index against a missing meeting.
   *
   * The caller is responsible for the audio file (see PipelineController.deleteMeeting): it lives
   * on the filesystem, not in the database, and only native can unlink it.
   */
  deleteMeeting: async (id: string) => {
    await run('DELETE FROM meetings_fts WHERE meeting_id = ?', [id]);
    await run('DELETE FROM meetings WHERE id = ?', [id]);
  },

  getMeeting: (id: string) =>
    run<Meeting>(
      'SELECT id, title, created_at AS createdAt, duration_ms AS durationMs, language, ' +
        'status, tier_used AS tierUsed, audio_retained AS audioRetained, summary_line AS summaryLine ' +
        'FROM meetings WHERE id = ?',
      [id],
    ).then(r => r[0]),

  setTitle: (id: string, title: string) =>
    run('UPDATE meetings SET title = ? WHERE id = ?', [title, id]),

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

  search: (term: string) => Storage.search(term).then(r => JSON.parse(r)),
};
