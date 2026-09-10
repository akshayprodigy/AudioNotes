// TurboModule spec for the encrypted (SQLCipher) store. Key lives in Android Keystore.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  open(): Promise<void>;
  // Typed query layer lives in src/db; this is the raw escape hatch.
  query(sql: string, params: string): Promise<string>; // params + result are JSON strings
  // Ranked full-text search across transcripts, minutes, titles and summaries (FTS5).
  // Returns a JSON array of SearchHit; see src/pipeline/types.ts.
  search(term: string): Promise<string>;
  // Rebuild one meeting's search index. Any JS write of indexed content (a rename, an edit, a
  // hand-written action item) must follow with this — only native can touch the FTS table.
  reindex(meetingId: string): Promise<void>;
  // Give one meeting its items if it was recorded before items existed: the rule pass re-run over
  // its stored transcript, plus the ticks moved off action_done onto the items that replace those
  // minutes. Pure text and milliseconds — no audio is touched and nothing is re-transcribed — so
  // it belongs on the path that opens a meeting, not in a chunked sweep like backfillSearch.
  // The caller is MeetingScreen.refresh, awaited before its read and memoised per opening
  // (db.ensureItems). It is not the only one any more — backfillItems below sweeps the same
  // migration across the library, because three cross-meeting views cannot wait for each meeting
  // to be opened — but it stays per-meeting and lazy, and both go through the same guard.
  ensureItems(meetingId: string): Promise<void>;
  // Migrate up to `limit` meetings recorded before items existed, newest first; resolves with how
  // many are still outstanding. Same shape and same reasons as backfillSearch: chunked and driven
  // from the app's sweep rather than run at open(), which on a Quick Settings cold start is the
  // main thread. It exists because ensureItems is per-meeting and the worklist, the Library's
  // outstanding-actions tally and Search's "meetings with actions" filter are all CROSS-meeting —
  // under lazy-only they show a library that has been opened rather than the library.
  // "Outstanding" is meetings with a transcript, no items and no items_migrated_at stamp; the
  // stamp is what stops a meeting whose transcript yields no items from being swept forever.
  backfillItems(limit: number): Promise<number>;
  // Index up to `limit` meetings that have never been indexed; resolves with how many are still
  // outstanding. Driven from the app's sweep so an existing library becomes searchable without a
  // blocking migration at open() — which, on a Quick Settings cold start, runs on the main thread.
  backfillSearch(limit: number): Promise<number>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Storage');
