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
  // ONE caller, and one is the design: MeetingScreen.refresh awaits it before its read, memoised
  // per opening (db.ensureItems). A second call site is the thing to resist — a Library card or a
  // sweep would run this per row against meetings mid-pipeline, which is the state its guard
  // ("has utterances, has no items") cannot tell apart from an unmigrated one.
  ensureItems(meetingId: string): Promise<void>;
  // Index up to `limit` meetings that have never been indexed; resolves with how many are still
  // outstanding. Driven from the app's sweep so an existing library becomes searchable without a
  // blocking migration at open() — which, on a Quick Settings cold start, runs on the main thread.
  backfillSearch(limit: number): Promise<number>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Storage');
