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

export type MinuteKind = 'summary' | 'decision' | 'action' | 'question';

export interface Minute {
  id: string;
  meetingId: string;
  kind: MinuteKind;
  content: string;
  source: 'rule' | 'llm';
}

export interface StageProgress {
  meetingId: string;
  stage: PipelineStage;
  chunk: number;
  total: number;
}
