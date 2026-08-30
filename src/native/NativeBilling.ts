// TurboModule spec for Google Play Billing.
//
// This buys things. It does not decide entitlement — a purchase produces a token, the licence
// server turns that token into a signed licence, and the native enforcement points check the
// signature. Nothing reachable from JavaScript can grant Pro.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface PlayPrice {
  /** Already localised by Google to the buyer's country and currency. Never reformat it. */
  price: string | null;
  /** ISO 8601 duration, e.g. P1M. */
  period: string | null;
  title: string | null;
}

export interface Spec extends TurboModule {
  /**
   * False when Play Billing cannot work here at all — no Play Store on the device, or a build
   * side-loaded or installed from another store. The UI offers the website in that case.
   */
  available(): Promise<boolean>;
  price(): Promise<PlayPrice | null>;
  /** Resolves with a purchase token, or null if the buyer backed out or payment is still pending. */
  purchase(): Promise<string | null>;
  /** A subscription this Google account already owns. Also what runs on a new device. */
  restore(): Promise<string | null>;
  /** Fallback for when the server could not be reached; Google refunds unacknowledged purchases. */
  acknowledgeLocally(purchaseToken: string): Promise<boolean>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Billing');
