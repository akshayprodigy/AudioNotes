// SQLCipher schema (encrypted at rest; key in Android Keystore).
// Persisting `status` per meeting makes processing resumable.
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
     archived_at INTEGER           -- NULL = in the library; set = hidden, restorable
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
     kind TEXT NOT NULL,            -- summary | decision | action | question
     content_json TEXT NOT NULL,
     source TEXT NOT NULL           -- rule | llm
   );`,
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
   );`, // onboarding flag + simple prefs
  `CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts
     USING fts5(meeting_id UNINDEXED, text);`,
];

export const MIGRATIONS: string[][] = [SCHEMA];
