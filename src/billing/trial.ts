import Licence, { type LicenceStatus } from '../native/NativeLicence';
import { db } from '../db/queries';

/**
 * What the screens may SAY about Pro, and when to offer it.
 *
 * The free trial is Play's (an offer on each base plan, see trialTerms.ts) and arrives as an
 * ordinary paid licence, so there is one question here: is there a licence. The in-app trial
 * that lived in this file until 23 Sep 2026 is gone from the product; its native half survives
 * in Trial.kt as a debug-only lever for the device tests.
 *
 * Enforcement is native and not here: Narrator, the model download and the Ask gate check a
 * signed licence a JS bundle cannot forge.
 */

/**
 * The licence store's monotonic clock, borrowed.
 *
 * LicenceStore.advanceClock keeps the highest unix second this install has ever seen in this
 * setting and never lets it go backwards — which is precisely the property a trial needs, and
 * precisely the property Date.now() does not have. Winding the phone back a week is otherwise the
 * whole attack: the window never closes and the trial never ends.
 *
 * It is native and read-only from here. It is also stripped from backups, so it cannot be carried
 * backwards from another device either.
 */
const KEY_CLOCK_FLOOR = 'licence_clock_floor';

/** When the contextual paywall was last shown, so it stays a moment rather than becoming a nag. */
const KEY_PAYWALL_SEEN = 'paywall_seen_at';

/** The recurring library offer: how many times it has been declined, and when it last appeared. */
const KEY_NUDGE_REFUSALS = 'pro_nudge_refusals';
const KEY_NUDGE_LAST_COUNT = 'pro_nudge_last_count';

const int = (v: string | null): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * Now, in unix seconds, on a clock that only moves forward.
 *
 * Reading the entitlement is what advances the native floor — LicenceStore.current calls
 * advanceClock on the way past — so status() is asked first even though its answer is thrown
 * away here. Then the floor is read back and taken as a lower bound on the system clock.
 *
 * The fallback to plain system time matters in exactly one case: a build with no licence public
 * key, where LicenceStore short-circuits to "unlicensed build, everything unlocked" and never
 * writes a floor. That is a development build in which Pro is free anyway, so there is nothing
 * for a wound-back clock to steal.
 */
export async function monotonicNow(): Promise<number> {
  await Licence.status().catch(() => null);
  const floor = int(await db.getSetting(KEY_CLOCK_FLOOR).catch(() => null));
  const system = Math.floor(Date.now() / 1000);
  return floor > 0 ? Math.max(system, floor) : system;
}

export interface Entitlement {
  /** May the paid features run: a Play subscription, including Play's free trial. */
  paid: boolean;
  licence: LicenceStatus | null;
}

/**
 * The one question every screen asks. Not enforcement — that is native — only what the UI may say.
 */
export async function entitlement(): Promise<Entitlement> {
  const licence = await Licence.status().catch(() => null);
  return { paid: Boolean(licence?.paid), licence };
}

/**
 * Whether this is the moment to offer Pro: once, off the first meeting that finished processing,
 * never to a subscriber, and never twice — the second showing is a nag, and this app's pitch is
 * that it does not behave like that.
 */
export async function shouldOfferPaywall(): Promise<boolean> {
  const seen = int(await db.getSetting(KEY_PAYWALL_SEEN).catch(() => null));
  if (seen > 0) return false;
  const { licence } = await entitlement();
  return !licence?.paid;
}

/** Remember that the offer was made. The paywall screen calls this itself, on open. */
export async function markPaywallSeen(): Promise<void> {
  const now = await monotonicNow();
  await db.setSetting(KEY_PAYWALL_SEEN, String(now)).catch(() => {});
}

/**
 * How often the library offers Pro again to a free user, counted in finished meetings.
 *
 * Deliberately "another N since we last asked" rather than "every Nth meeting". Somebody who
 * imports four files at once moves the count 4 -> 7, and a multiple-of-N rule steps straight over
 * the threshold and never fires again. This form also copes with deletion: the count can fall, and
 * nothing is offered again until it has genuinely grown past where it was.
 */
export const NUDGE_EVERY = 5;

/**
 * After this many refusals the app stops asking, permanently.
 *
 * Somebody who has said no three times is not a customer being lost by silence — they are one
 * being kept by it. This product's whole pitch is that it does not behave like the incumbents, and
 * "it keeps nagging me" is the most common complaint levelled at them.
 */
export const NUDGE_MAX_REFUSALS = 3;

export interface NudgeInput {
  /** Meetings that reached 'done'. One still processing has shown the user nothing. */
  completed: number;
  /** `completed` at the moment the card was last shown; 0 if it never has been. */
  lastShownAt: number;
  refusals: number;
  /** Only `paid` is read: it is already true for a subscriber, including one on Play's trial. */
  entitlement: Pick<Entitlement, 'paid'>;
}

/** Whether the library should offer Pro right now. Pure: no clock, no database. */
export function shouldNudgeForPro(i: NudgeInput): boolean {
  if (i.entitlement.paid) return false;
  if (i.refusals >= NUDGE_MAX_REFUSALS) return false;
  return i.completed >= i.lastShownAt + NUDGE_EVERY;
}

export interface NudgeState {
  refusals: number;
  lastShownAt: number;
}

/**
 * Both halves of the nudge's memory, read together so a render never sees one without the other.
 *
 * Every read is guarded: a settings row that cannot be read degrades to "never shown, never
 * refused", which at worst offers Pro once more than intended. Defaulting the other way would
 * silence the feature permanently on a transient error, and nothing would ever report it.
 */
export async function nudgeState(): Promise<NudgeState> {
  const [refusals, lastShownAt] = await Promise.all([
    db.getSetting(KEY_NUDGE_REFUSALS).catch(() => null),
    db.getSetting(KEY_NUDGE_LAST_COUNT).catch(() => null),
  ]);
  return { refusals: int(refusals), lastShownAt: int(lastShownAt) };
}

/** Called when the card is actually rendered, not when it merely becomes eligible. */
export async function noteNudgeShown(completed: number): Promise<void> {
  await db.setSetting(KEY_NUDGE_LAST_COUNT, String(completed)).catch(() => {});
}

/** "Not now". Counts towards NUDGE_MAX_REFUSALS, after which the card never returns. */
export async function refuseNudge(): Promise<void> {
  const { refusals } = await nudgeState();
  await db.setSetting(KEY_NUDGE_REFUSALS, String(refusals + 1)).catch(() => {});
}

/**
 * Models that are part of Pro but are not the LLM.
 *
 * The native catalog decides subscription-gating by `kind == "llm"`, which was right when the LLM
 * was the only paid thing in it. whisper-small is the other one: it is a straight accuracy upgrade
 * — better with accents, crosstalk and a bad room — and the PRD always had it on the paid side.
 *
 * Keyed by id rather than kind, because the free tier's floor is whisper-base and that floor is a
 * promise. Gating `kind == "asr"` would take the guaranteed path away with it.
 *
 * This list is what the UI shows. The refusal that MATTERS is ModelCatalog.needsSubscription, on
 * the native side, and until it names this id too a free user can still fetch the weights.
 */
export const PRO_MODEL_IDS: readonly string[] = ['whisper-small', 'qwen3-asr'];

export function isProModel(m: { id: string; needsSubscription: boolean }): boolean {
  return m.needsSubscription || PRO_MODEL_IDS.includes(m.id);
}
