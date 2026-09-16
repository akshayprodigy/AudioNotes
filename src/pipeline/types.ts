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
 * `user` rows are PROSE a person wrote themselves — a summary, a write-up, a headline. A typed
 * decision, action or open question was one of these until Task 12 and is an `items` row now
 * (db.addUserItem), because a list row wants a stable id for its tick and its correction and a
 * document wants none of that. `replaceMinutes` is scoped by source, so reprocessing can never
 * delete what is left here.
 *
 * A `user` row of an ITEM kind therefore means exactly one thing now: a meeting
 * `AudioDb.carryUserMinutesOntoItems` has not reached yet.
 */
export type MinuteSource = 'rule' | 'llm' | 'user';

export interface Minute {
  id: string;
  meetingId: string;
  kind: MinuteKind;
  content: string;
  source: MinuteSource;
}

/**
 * What a person edited by hand, and what the correction is keyed on.
 *
 * `'item'` is keyed on `items.id`, which is the only one of these that survives the text being
 * REWRITTEN — a reprocess hands a matched item its id back, so a correction outlives a
 * re-recognition that changes a word. Every other kind is keyed on the original text or on a row
 * id: `'utterance'` on the utterance id, `'summary'`/`'narrative'` on `DOC_KEY` (there is one of
 * each per meeting), and `'minute'` on `itemKey` of the stored minute's content.
 *
 * `'minute'` is what every shipped build wrote for a decision, an action or an open question.
 * Those rows are MOVED onto `'item'` by `AudioDb.carryEditsOntoItems`, which runs before anything
 * reads a meeting; what still writes `'minute'` is the ONE population that has no item to key on —
 * every row of a meeting whose item migration has not run. A row somebody typed themselves was the
 * second such population until Task 12 gave it an item of its own.
 */
/** 'speaker' edits hold a speaker id, not text: who a person says spoke the line. */
export type EditTarget = 'utterance' | 'minute' | 'item' | 'summary' | 'narrative' | 'speaker';

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
 * A zero on an `'item'` hit is not a contradiction of that: an item a PERSON typed never claimed a
 * moment, and `AudioDb.indexItems` writes 0 for it deliberately — the same "open at the top" every
 * other kind means by it. It is the sentinel anchor such a row really stores that must never reach
 * this field.
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

/**
 * `items.gen_version` for a row a person typed, and the AUTHORITATIVE marker of one.
 *
 * The JavaScript mirror of `AudioDb.Gen.USER` in Kotlin, and a genuine cross-language contract
 * rather than a tidy-up: JavaScript is the only thing that WRITES this string (db.addUserItem),
 * and Kotlin is what reads it — `Reconciler` rule 1 refuses to match, replace or flag a row
 * carrying it, so an item a person wrote is never consumed by an extracted one; `AudioDb.items`
 * and `FileExportModule.exportItems` refuse it an anchor; `AudioDb.indexItems` indexes it at the
 * top of the recording rather than at its sentinel.
 *
 * CHANGING IT ON ONE SIDE FAILS NO BUILD AND RAISES NOTHING. The two spellings meet only inside
 * the database, so a drift shows up as hand-typed items quietly losing rule 1's protection and
 * being swallowed by the next reprocess. The pin is a pair of tests that assert the literal on
 * each side and name the other — src/db/__tests__/userItems.test.ts and
 * android/.../UserItemsTest.kt — the same instrument `ItemKeyTest` and `__tests__/actionKey.test.ts`
 * use for `ItemKey`, and `ExportItemsTest`/`ItemProvenance.test.tsx` for the timestamp format.
 *
 * If a VERSIONED user gen is ever wanted — `user@1`, the convention `rules@1` already sets — it
 * changes here, in `AudioDb.Gen`, and in the `CASE` inside db.allActions, together or not at all.
 */
export const USER_GEN = 'user';

/**
 * `minutes.source` for a row a person wrote — a DIFFERENT column and a different vocabulary from
 * [USER_GEN], which happens to spell this one value the same way.
 *
 * [MinuteSource] is `rule | llm | user` and names WHICH PIPELINE wrote a minute; `items.gen_version`
 * is `rules@1 | user` and VERSIONS the extractor that produced an item. Two constants because they
 * are two facts, and because they sit twenty lines apart in `toItemRows` — `it.genVersion ===
 * USER_GEN` for an item, `m.source === MINUTE_SOURCE_USER` for a minute — which is close enough
 * that replacing the second with the first reads like a tidy-up. It compiles, it passes every
 * test, and the day a versioned `user@1` gen exists it silently sets `mine = false` on every
 * unmigrated meeting's typed row, taking its remove button with it.
 *
 * `AudioDb.MINUTE_SOURCE_USER` is the Kotlin twin, added for exactly this in
 * `carryUserMinutesOntoItems`, which reads one while writing the other.
 */
export const MINUTE_SOURCE_USER: MinuteSource = 'user';

/**
 * What `items.anchor_start_ms` / `anchor_end_ms` hold for a row that never claimed a moment.
 *
 * `anchor_start_ms` is `INTEGER NOT NULL` and SQLite cannot make a column nullable without
 * rebuilding the table, so a hand-typed row still has to store a number. This one is chosen for
 * two properties and nothing else:
 *
 *  - **It sorts last.** Every read of `items` is `ORDER BY anchor_start_ms, rowid`, so the value
 *    decides where a hand-typed row appears. `0` — what this task's listing proposed — would put
 *    every typed row at the TOP of every meeting, reversing the order they have always had (they
 *    lived in `minutes` and were appended after the items) and undoing the determinism Task 10
 *    built on purpose. Above every real anchor, they stay where they were, ordered among
 *    themselves by rowid, which is the order they were typed in.
 *  - **It is exactly representable in JavaScript.** Every query parameter crosses the bridge as
 *    JSON, so a sentinel above 2^53 arrives rounded: `Long.MAX_VALUE` becomes
 *    9223372036854775808, which SQLite then stores as a REAL in an INTEGER column. 2^53-1 is
 *    285,000 years of recording, so nothing real will ever reach it.
 *
 * NOTHING READS IT BACK AS A NUMBER. "This row has no moment" is derived at each database
 * boundary from [USER_GEN] — never by comparing against this value — so the sentinel stays an
 * implementation detail of the column's NOT NULL, and a reader that forgot to ask would be handed
 * an absurd number rather than a plausible `0:00` it would happily print.
 */
export const NO_ANCHOR = Number.MAX_SAFE_INTEGER;

/**
 * The three kinds that live in `items`. `summary`, `narrative` and `headline` are prose and stay
 * in `minutes` — they are documents, one of each per meeting, with no anchor, no tick and no
 * provenance, so `items` has nothing to offer them.
 *
 * FIVE PLACES SELECT ON EXACTLY THIS SET, and they are listed here because this is the type the
 * other four are named against:
 *
 *  - this type, and `ITEM_KINDS` in src/screens/meeting/shared.tsx, its runtime half — which
 *    `db.addUserItem`'s signature, `toItemRows`' merge guard and MeetingScreen's add path all
 *    share, through `isItemKind`;
 *  - `FileExportModule.ITEM_KINDS` in Kotlin, for the export renderer;
 *  - `AudioDb.ITEM_KINDS` in Kotlin, for `carryUserMinutesOntoItems`' `kind IN (...)`.
 *
 * They are mirrors and not one list, because the two languages cannot share a declaration — so the
 * count is stated here, where somebody adding a sixth kind starts, rather than left to be
 * discovered one file at a time.
 */
export type ItemKind = 'decision' | 'action' | 'question';

/** A decision, action or question, with the evidence behind it. */
export interface Item {
  id: string;
  meetingId: string;
  kind: ItemKind;
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
  /**
   * When it was said, or `null` for a row that never claimed to have been said at all.
   *
   * NULLABLE because a hand-typed row is an `items` row now, and the column it comes out of is
   * `INTEGER NOT NULL` — see [NO_ANCHOR]. The null is derived at the boundary, in db.items, from
   * `gen_version`, so no screen, renderer or export ever meets the stored sentinel. Read
   * `anchorStartMs === null` as "this row has no evidence to show", which is what the provenance
   * button on both tabs is gated on: an item with no sources is not a failure to find evidence,
   * it is an item that never claimed any.
   */
  anchorStartMs: number | null;
  anchorEndMs: number | null;
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
   * When it was said. STILL no reader on this type, and Task 10 is not it.
   *
   * Task 10 built the tap-to-the-moment gesture inside a meeting, off `items.anchor_start_ms`
   * directly (src/screens/meeting/ItemProvenance.tsx). Sending the WORKLIST to that moment needs
   * `Meeting`'s route params to carry an item's position rather than only a transcript hit's, and
   * `ActionsScreen` has no entry point wired to it at all — see "Discovered during Task 9". It is
   * carried anyway because the worklist is the one list that can send you to a claim you do not
   * remember, and the row is worthless without the sentence it came from being findable.
   *
   * NULL for a hand-typed action, derived in the SELECT from `gen_version` beside the `source`
   * CASE that was already there — see [NO_ANCHOR]. The worklist shows hand-typed actions for the
   * first time as of Task 12, and the reader this field is waiting for would otherwise be handed
   * a sentinel and send somebody 285,000 years into a recording. Widening the type now is what
   * makes that reader's `null` check a compile error rather than a judgement call.
   */
  anchorStartMs: number | null;
  done: boolean;
}

export interface StageProgress {
  meetingId: string;
  stage: PipelineStage;
  chunk: number;
  total: number;
}
