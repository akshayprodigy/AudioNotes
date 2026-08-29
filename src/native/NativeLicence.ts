// TurboModule spec for the subscription licence.
//
// Read-mostly. Enforcement lives natively, in Narrator.run — nothing here decides whether a paid
// feature runs, it only decides what the screens are allowed to say about it.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type LicenceState = 'none' | 'active' | 'expired';

export interface LicenceStatus {
  plan: string;
  /**
   * `none` and `expired` are deliberately different. "Your subscription ran out" is worth showing
   * someone; "there is no licence here" is the ordinary state of every free user and earns no
   * interruption at all.
   */
  state: LicenceState;
  paid: boolean;
  /** Unix seconds; 0 when there is nothing to expire. */
  expiresAt: number;
  account: string | null;
  /** What to say when the subscription has lapsed. Server-supplied, so policy can move without a release. */
  lapsedCopy: string;
}

export interface Spec extends TurboModule {
  status(): Promise<LicenceStatus>;
  /** `refreshKey` is null on a plain renewal, which must not clear the one already stored. */
  store(token: string, refreshKey: string | null): Promise<boolean>;
  refreshKey(): Promise<string | null>;
  /** Empty when this build has no licence server, in which case sign-in is unavailable. */
  baseUrl(): Promise<string>;
  clear(): Promise<void>;
  deviceId(): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Licence');
