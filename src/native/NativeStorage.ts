// TurboModule spec for the encrypted (SQLCipher) store. Key lives in Android Keystore.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  open(): Promise<void>;
  // Typed query layer lives in src/db; this is the raw escape hatch.
  query(sql: string, params: string): Promise<string>; // params + result are JSON strings
  // Full-text search across utterances + minutes (FTS5).
  search(term: string): Promise<string>; // JSON array of meeting hits
}

export default TurboModuleRegistry.getEnforcing<Spec>('Storage');
