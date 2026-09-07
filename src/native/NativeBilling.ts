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

/**
 * One base plan as Play describes it. `price` is what the buyer will be charged now; `fullPrice`
 * is the standing rate they are NOT being charged, and exists only when Play reports an
 * introductory or promotional phase.
 *
 * A struck-through price may be drawn from `fullPrice` and from nowhere else. A reference price
 * the seller never charged is a fabricated anchor — forbidden by the EU Omnibus Directive and
 * India's dark-pattern rules, and grounds for Play rejection. The legitimate alternative needs no
 * new field: an annual plan can be struck through against twelve times the monthly price, which
 * is arithmetic over `priceMicros` and true by construction.
 */
export interface PlayPlan {
  /** The id set in Play Console. Pass it back to purchase() — never rely on ordering. */
  basePlanId: string;
  /** Already localised by Google. Never reformat it. */
  price: string | null;
  /** The same amount as a number, for comparisons the UI must not do on a formatted string. */
  priceMicros: number;
  /** ISO 8601 duration, e.g. P1M or P1Y. */
  period: string | null;
  /** The standing price, when an introductory phase means it is not what is charged today. */
  fullPrice: string | null;
  title: string | null;
}

export interface Spec extends TurboModule {
  /**
   * False when Play Billing cannot work here at all — no Play Store on the device, or a build
   * side-loaded or installed from another store. The UI offers the website in that case.
   */
  available(): Promise<boolean>;
  /** Every base plan Play offers — monthly and annual. Empty when none can be read. */
  plans(): Promise<PlayPlan[]>;
  /** The first base plan only. Kept for compatibility; prefer plans(). */
  price(): Promise<PlayPrice | null>;
  /**
   * Resolves with a purchase token, or null if the buyer backed out or payment is still pending.
   *
   * `basePlanId` says WHICH plan. With more than one configured, omitting it is refused rather
   * than guessed: picking the first would let a tap on "monthly" charge a year up front.
   */
  purchase(basePlanId: string | null): Promise<string | null>;
  /** A subscription this Google account already owns. Also what runs on a new device. */
  restore(): Promise<string | null>;
  /** Fallback for when the server could not be reached; Google refunds unacknowledged purchases. */
  acknowledgeLocally(purchaseToken: string): Promise<boolean>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Billing');
