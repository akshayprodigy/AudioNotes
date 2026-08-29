// TurboModule spec for encrypted backup and restore.
//
// There is no cloud sync and there is not going to be one, so moving to a new phone is a file the
// user carries. The backup is encrypted under a passphrase THEY choose — which means a forgotten
// passphrase is an unreadable backup, by them and by us. Any UI here has to say that plainly.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /** Write an encrypted backup and hand it to the share sheet. Resolves the file name. */
  exportAndShare(passphrase: string): Promise<string>;
  /**
   * Open the system file picker and restore what comes back.
   * Resolves the number of meetings restored, or null if the user cancelled.
   */
  pickAndRestore(passphrase: string): Promise<number | null>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Backup');
