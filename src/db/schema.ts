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
     announced_at INTEGER          -- when the spoken disclosure finished, while the mic was live
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
