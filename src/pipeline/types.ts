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
  // Terminal, and written only by the native pipeline (ProcessingEngine.kt): speech was heard in a
  // language this build does not transcribe, so nothing was written and the audio was kept. It
  // belongs in this union because its absence is what let both screens treat a finished meeting as
  // one still in flight — the library showed a live TRANSCRIBING badge and the meeting screen span
  // on "Writing your notes..." with nothing running behind it.
  | 'unsupported_language'
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
  /**
   * Set when a person overruled a "not English" refusal on this meeting. Both the reason the run
   * bypassed detection and the reason its result is marked forever.
   */
  transcribeForcedAt?: number | null;
  /** What was heard before they overruled it. Null when detection never named a language. */
  forcedFromLanguage?: string | null;
  /**
   * Why this meeting has no speaker labels, when the reason was the phone and not the recording.
   *
   * Written by the pipeline at the moment it decided, because the decision was made against the
   * memory free at the time: re-deriving it when the screen opens would answer a different
   * question on a phone that has since been rebooted. Null is the ordinary case — it covers both
   * "diarization ran" and "there was nobody to separate".
   */
  diarSkippedReason?: string | null;
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
 *
 * `'item'` is a decision, action or question with its own provenance, indexed by AudioDb at the
 * moment it was said — so it is the SECOND kind whose `startMs` means something. `'title'`,
 * `'minute'` and `'summary'` are all indexed at 0, and any code that treats a zero here as "this
 * kind has no moment" is now wrong for one of the five.
 *
 * Adding a member to this union does NOT fail a build on its own: SearchScreen's `kindMeta`
 * switches on it with a `default` branch, which swallows an unhandled kind and labels it "TITLE".
 * A new member needs its own `case` there, by hand — and src/screens/__tests__/searchKinds.test.ts
 * is what turns the omission back into a compile error, because the `default` branch cannot.
 */
export interface SearchHit {
  meetingId: string;
  kind: 'utterance' | 'title' | 'minute' | 'summary' | 'item';
  refId: string | null;
  startMs: number;
  snippet: string;
  score: number;
}

/**
 * One passage of the recording supporting an item, as it comes back OUT of the database.
 *
 * `DraftItemSource` in src/pipeline/evidence.ts is the same thing on the way IN — what the
 * extractor produces before anything is persisted — and the difference between them is the whole
 * reason both exist: `utteranceId` is always known at extraction and is NULLABLE here, because
 * AudioDb.replaceUtterancesJson mints fresh utterance ids on every ASR run and a stored id can be
 * pointing at nothing by the time it is read back. They carried the same name until the two were
 * one import away from typing that null as a string. `startMs` is the anchor and the identity; the
 * utterance id is a convenience, so never depend on it across runs.
 */
export interface ItemSource {
  startMs: number;
  endMs: number;
  /** UTF-16 code units into the turn's text, matching JavaScript's own string indices. */
  charStart: number;
  charEnd: number;
  utteranceId: string | null;
}

/** A decision, action or question, with the evidence behind it. */
export interface Item {
  id: string;
  meetingId: string;
  kind: 'decision' | 'action' | 'question';
  text: string;
  /**
   * What the REVIEW COLUMN says, which is much less than "has anybody engaged with this".
   *
   * `confirmed` and `rejected` are the only two a person put there (AudioDb.Review.BY_A_PERSON).
   * `needs_review` is the machine flagging ITSELF: Reconciler writes it on every ambiguous match,
   * so it says nothing whatever about a person. And `suggested` is not "nobody has looked" — a
   * ticked item still reads `suggested`, because the tick is a row in `item_done`, and so does a
   * hand-corrected one, because the correction is a row in `edits`.
   *
   * So `review === 'suggested'` does NOT mean untouched, and the whole predicate exists in exactly
   * one place: AudioDb.items()' `touched`, assembled at that boundary across four tables. Ask for
   * the answer, never rebuild it from the ingredients — see db.items() for what that means on this
   * side, and for why this type does not carry it.
   */
  review: 'suggested' | 'needs_review' | 'confirmed' | 'rejected';
  genVersion: string;
  anchorStartMs: number;
  anchorEndMs: number;
  sources: ItemSource[];
}

/**
 * An action item lifted out of its meeting, for the cross-meeting worklist.
 *
 * `id` is the item's id, and it is what the tick is keyed on. It replaced an `itemKey` field
 * holding a hash of `content`, which moved whenever the wording did — so re-recognising a single
 * word in a reprocessed meeting unticked work somebody had already done.
 */
export interface ActionRow {
  meetingId: string;
  meetingTitle: string;
  createdAt: number;
  id: string;
  content: string;
  /** Where the row came from, derived from `items.gen_version`. See db.allActions. */
  source: MinuteSource;
  /**
   * When it was said. No reader yet: Task 10 is what opens the meeting at that moment, and it is
   * carried now because the worklist is the one list that can send you to a claim you do not
   * remember — the row is worthless without the sentence it came from being findable.
   */
  anchorStartMs: number;
  done: boolean;
}

export interface StageProgress {
  meetingId: string;
  stage: PipelineStage;
  chunk: number;
  total: number;
}
