// Shared types for the offline pipeline. Mirrors the SQLCipher schema (src/db/schema.ts).

export type MeetingStatus =
  | 'recording'
  | 'captured'
  | 'vad'
  | 'asr'
  | 'diarized'
  | 'aligned'
  | 'structured'
  | 'done'
  | 'error';

export type PipelineStage = 'vad' | 'asr' | 'diarize' | 'minutes' | 'align' | 'structure';

// Terminal outcome of a processing run, as reported by onStageComplete/onError.
export type PipelineOutcome = 'done' | 'cancelled' | 'error';

export interface Meeting {
  id: string;
  title: string;
  createdAt: number;
  durationMs: number;
  language: string | null;
  status: MeetingStatus;
  tierUsed: 'free' | 'pro';
  /** 0 once the raw audio has been discarded post-transcription (see Settings > Keep the audio). */
  audioRetained: number;
  /**
   * One-line description of the meeting, written by the on-device LLM. Null until narration runs,
   * and stays null on devices that cannot run it or for recordings too short to summarise without
   * inventing — the library row falls back to the live processing state.
   */
  summaryLine?: string | null;
}

export interface Utterance {
  id: string;
  meetingId: string;
  startMs: number;
  endMs: number;
  speakerId: string;
  text: string;
}

export interface Speaker {
  id: string;
  meetingId: string;
  clusterLabel: string;
  displayName: string;
}

/**
 * `summary` and `narrative` are LLM prose; `headline` is the one-liner mirrored onto
 * meetings.summary_line. The rest come from rule extraction, where every item quotes the meeting.
 */
export type MinuteKind =
  | 'summary'
  | 'narrative'
  | 'headline'
  | 'decision'
  | 'action'
  | 'question';

/**
 * Where a minute came from.
 *
 * `user` rows are items a person typed themselves — a decision the model missed, an action nobody
 * said out loud. They are stored in the same table on purpose: every kind-based filter picks them
 * up with no extra code, they export and back up for free, and `replaceMinutes` is scoped by
 * source so reprocessing can never delete them.
 */
export type MinuteSource = 'rule' | 'llm' | 'user';

export interface Minute {
  id: string;
  meetingId: string;
  kind: MinuteKind;
  content: string;
  source: MinuteSource;
}

/** What a person edited by hand, keyed to the original text the pipeline wrote. */
export type EditTarget = 'utterance' | 'minute' | 'summary' | 'narrative';

export interface Edit {
  meetingId: string;
  targetKind: EditTarget;
  targetKey: string;
  content: string;
  editedAt: number;
}

/**
 * One full-text hit.
 *
 * `kind` says what was matched so the result can be labelled, and `startMs` carries the moment a
 * transcript hit was spoken so tapping it can open the meeting at that point. The snippet arrives
 * with matched terms wrapped in U+0002/U+0003 — control characters chosen because no transcript
 * will ever contain them, so splitting on them cannot corrupt real text.
 */
export interface SearchHit {
  meetingId: string;
  kind: 'utterance' | 'title' | 'minute' | 'summary';
  refId: string | null;
  startMs: number;
  snippet: string;
  score: number;
}

/** An action item lifted out of its meeting, for the cross-meeting worklist. */
export interface ActionRow {
  meetingId: string;
  meetingTitle: string;
  createdAt: number;
  content: string;
  source: MinuteSource;
  itemKey: string;
  done: boolean;
}

export interface StageProgress {
  meetingId: string;
  stage: PipelineStage;
  chunk: number;
  total: number;
}
