// SQLCipher schema (encrypted at rest; key in Android Keystore).
// Persisting `status` per meeting makes processing resumable.
//
// NOT THE SOURCE OF TRUTH. Nothing imports this file. StorageModule delegates every query to
// AudioDb, so `AudioDb.SCHEMA` and `AudioDb.ADDED_COLUMNS` are the declarations that actually run
// and a column added here alone will not exist. Kept in step with them because it is the readable
// copy — change both.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meetings (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     duration_ms INTEGER NOT NULL DEFAULT 0,
     language TEXT,
     status TEXT NOT NULL DEFAULT 'recording',
     tier_used TEXT NOT NULL DEFAULT 'free',
     audio_path TEXT,
     audio_retained INTEGER NOT NULL DEFAULT 1,
     archived_at INTEGER,          -- NULL = in the library; set = hidden, restorable
     summary_line TEXT,            -- one-line description written by the LLM; NULL until narrated
     transcribe_forced_at INTEGER, -- set when a person overruled the "not English" refusal
     forced_from_language TEXT,    -- what was heard before they did; the banner's claim
     announced_at INTEGER,         -- when the spoken disclosure finished, while the mic was live
     diar_skipped_reason TEXT      -- why this meeting has no speakers, when the cause was memory
   );`,
  `CREATE TABLE IF NOT EXISTS utterances (
     id TEXT PRIMARY KEY,
     meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     start_ms INTEGER NOT NULL,
     end_ms INTEGER NOT NULL,
     speaker_id TEXT,
     text TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS speakers (
     id TEXT PRIMARY KEY,
     meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     cluster_label TEXT NOT NULL,
     display_name TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS minutes (
     id TEXT PRIMARY KEY,
     meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,            -- summary | narrative | headline | decision | action | question
     content_json TEXT NOT NULL,
     source TEXT NOT NULL           -- rule | llm  (both coexist: rules own the items, the LLM the prose)
   );`,
  `CREATE TABLE IF NOT EXISTS llm_notes (
     meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     chunk_index INTEGER NOT NULL,
     note TEXT NOT NULL,
     PRIMARY KEY (meeting_id, chunk_index)
   );`, // per-chunk narration checkpoint, cleared once the meeting is narrated
  // Typed items with their provenance. `minutes` keeps prose only — summary, narrative and
  // headline — and every decision, action and question lives here instead.
  //
  // item_type, status, owner_json, date_said and date_norm are NULL for a free user and stay
  // NULL: they are written by the Pro classifier in Phase B. The column exists now so Phase B
  // is a write, not a migration.
  //
  // id is NOT NULL explicitly: SQLite's TEXT PRIMARY KEY allows NULL unless said so (only
  // INTEGER PRIMARY KEY implies it), and two NULL-id rows would not even collide.
  `CREATE TABLE IF NOT EXISTS items (
     id TEXT PRIMARY KEY NOT NULL,
     meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,            -- decision | action | question
     item_type TEXT,                -- Phase B: the classifier's finer type
     status TEXT,                   -- Phase B
     text TEXT NOT NULL,
     owner_json TEXT,               -- Phase B
     date_said TEXT,                -- Phase B: the date phrase as spoken
     date_norm INTEGER,             -- Phase B: that phrase normalised to an epoch
     review TEXT NOT NULL DEFAULT 'suggested',
     gen_version TEXT NOT NULL,
     anchor_start_ms INTEGER NOT NULL,
     anchor_end_ms INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS idx_items_meeting ON items(meeting_id, anchor_start_ms);`,
  // The evidence. start_ms/end_ms/char_start/char_end are the anchor and the identity;
  // utterance_id is a convenience re-resolved on every run, because AudioDb.replaceUtterancesJson
  // mints fresh UUIDs each time and the old ones point at nothing. Do not "normalise"
  // utterance_id into a foreign key: the millisecond/char-offset columns are what survives a
  // re-ASR, a text edit and a speaker merge, and the utterance id does not.
  //
  // char_start/char_end are NOT NULL: both producers (evidence.ts, evidence.h) always emit a
  // span, and a source without one is meaningless. Nullable here would be silently dangerous
  // rather than absent — a missing span would read back as "starts at the beginning of the turn"
  // and Task 10's provenance UI would highlight the wrong text instead of visibly failing.
  //
  // WARNING for anything that reconstructs item text from these offsets: this is NOT
  // turn.substr(char_start, char_end - char_start) in general, in EITHER language. The item's
  // text can differ from that slice whenever the turn's whitespace needed collapsing to find the
  // sentence (extra spaces, tabs, newlines) — src/pipeline/__tests__/evidence.test.ts:145 is the
  // TypeScript counterexample: the slice keeps a double space and a newline the item text does
  // not. The C++ port diverges more often still, because the extractor also folds U+2019 to a
  // plain apostrophe before matching, so the slice differs on every turn with a curly apostrophe
  // too — most meetings. Read the item's own text field; do not reconstruct it by slicing the
  // transcript, in either language.
  `CREATE TABLE IF NOT EXISTS item_sources (
     item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
     ordinal INTEGER NOT NULL,
     start_ms INTEGER NOT NULL,
     end_ms INTEGER NOT NULL,
     char_start INTEGER NOT NULL,
     char_end INTEGER NOT NULL,
     utterance_id TEXT,
     PRIMARY KEY (item_id, ordinal)
   );`,
  // Replaces action_done. Keyed on the item's stable id rather than a hash of its text, so a tick
  // survives a re-recognition that changes one word. Task 8 migrates the old rows; action_done
  // itself stays (do not delete it) so a rolled-back build still finds its ticks.
  //
  // Deliberately NO REFERENCES items(id): Task 6's replaceItems deletes and re-inserts every item
  // row on every reprocess, so an ON DELETE CASCADE here would wipe every tick on every
  // reprocess — the exact failure this table exists to end. Do not "fix" this later.
  `CREATE TABLE IF NOT EXISTS item_done (
     meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     item_id TEXT NOT NULL,
     done_at INTEGER NOT NULL,
     PRIMARY KEY (meeting_id, item_id)
   );`,
  `CREATE TABLE IF NOT EXISTS action_done (
     meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     item_key TEXT NOT NULL,        -- hash of the item text, NOT a minutes row id
     done_at INTEGER NOT NULL,
     PRIMARY KEY (meeting_id, item_key)
   );`, // ticked-off actions; keyed on text so reprocessing does not uncheck them
  `CREATE TABLE IF NOT EXISTS segments (
     meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
     start_ms INTEGER NOT NULL,
     end_ms INTEGER NOT NULL
   );`, // VAD speech spans (silence stripped)
  `CREATE TABLE IF NOT EXISTS models (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     kind TEXT NOT NULL,            -- vad | asr | diar | llm
     version TEXT,
     path TEXT,
     sha256 TEXT,
     size_bytes INTEGER,
     installed_at INTEGER
   );`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS network_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,          -- epoch ms
     kind TEXT NOT NULL,           -- 'licence' | 'models' | 'crash'
     host TEXT NOT NULL,           -- 'huggingface.co'
     sent INTEGER NOT NULL DEFAULT 0,     -- request BODY bytes; headers are excluded
     received INTEGER NOT NULL DEFAULT 0,
     detail TEXT                   -- 'token refresh', 'ggml-base-q5_1.bin'
   );`, // onboarding flag + simple prefs
  `CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts
     USING fts5(meeting_id UNINDEXED, text);`,
];

export const MIGRATIONS: string[][] = [SCHEMA];
