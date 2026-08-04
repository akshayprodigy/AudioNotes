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
        'status, tier_used AS tierUsed, audio_retained AS audioRetained ' +
        'FROM meetings ORDER BY created_at DESC',
    ),

  getMeeting: (id: string) =>
    run<Meeting>(
      'SELECT id, title, created_at AS createdAt, duration_ms AS durationMs, language, ' +
        'status, tier_used AS tierUsed, audio_retained AS audioRetained ' +
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

  // Replace the rule-based minutes for a meeting.
  replaceMinutes: async (meetingId: string, mins: { kind: string; content: string; source: string }[]) => {
    await run('DELETE FROM minutes WHERE meeting_id = ?', [meetingId]);
    for (let i = 0; i < mins.length; i++) {
      const m = mins[i];
      await run('INSERT INTO minutes(id, meeting_id, kind, content_json, source) VALUES(?,?,?,?,?)', [
        `${meetingId}:${i}`,
        meetingId,
        m.kind,
        m.content,
        m.source,
      ]);
    }
  },

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
