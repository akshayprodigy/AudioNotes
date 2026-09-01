import Licence, { type LicenceStatus } from '../native/NativeLicence';
import { db } from '../db/queries';

/**
 * The free trial of Pro.
 *
 * Pro sells one thing today: prose. A free user gets minutes pulled out by rule, which is a real
 * product and always will be — but nobody buys prose minutes off a screenshot. They buy them
 * after seeing what the model wrote about THEIR meeting, with their colleagues' names in it. So
 * the trial exists to put that on the screen once, on real material, and then get out of the way.
 *
 * Two limits, whichever runs out first, because each one alone fails a different person:
 *
 *   - A time window alone is worthless to the person who records one meeting a fortnight. Seven
 *     days of a trial they never opened is not a trial.
 *   - A summary cap alone never ends for the person who stops using the app in week two, so the
 *     entitlement hangs around indefinitely and the decision never gets made.
 *
 * Both numbers are here at the top on purpose: they are a pricing decision, not an engineering
 * one, and they will be tuned before launch by someone reading a spreadsheet rather than this file.
 */
export const TRIAL_DAYS = 7;
export const TRIAL_SUMMARIES = 3;

const DAY_SECONDS = 24 * 60 * 60;

/**
 * The three keys the trial lives in, and the one thing that makes them tamper-resistant.
 *
 * BackupManager.LOCAL_SETTINGS strips exactly these names from an export. That is not tidiness:
 * without it, "back up, burn the trial, restore" resets the counter forever and the trial is a
 * subscription. Renaming any of them silently re-opens that hole, because the strip list matches
 * on literal names — so if one of these ever changes, it changes in BackupManager in the same
 * commit. (Lane 1 owns that file; the names below are the ones already listed there.)
 */
const KEY_STARTED = 'trial_started_at';
const KEY_USED = 'trial_summaries_used';
const KEY_ENDED = 'trial_ended_at';

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

export type TrialStatus = 'unstarted' | 'active' | 'ended';

/** Why a trial is over. Worth distinguishing: the two want different sentences on screen. */
export type TrialEndReason = 'time' | 'summaries' | null;

export interface TrialState {
  status: TrialStatus;
  /** Whole days remaining, rounded up so the last part-day still reads as "1 day left". */
  daysLeft: number;
  summariesLeft: number;
  /** Unix seconds, 0 when it has not started. */
  startedAt: number;
  endedAt: number;
  used: number;
  endedBecause: TrialEndReason;
}

const UNSTARTED: TrialState = {
  status: 'unstarted',
  daysLeft: TRIAL_DAYS,
  summariesLeft: TRIAL_SUMMARIES,
  startedAt: 0,
  endedAt: 0,
  used: 0,
  endedBecause: null,
};

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

function shape(started: number, used: number, ended: number, now: number): TrialState {
  if (started === 0) return UNSTARTED;

  // A start stamp in the future means the floor moved under us — a corrected clock, or a licence
  // refresh landing between two reads. Clamping is kinder than showing "8 days left" on a
  // seven-day trial, and it can only ever shorten the window, never extend it.
  const from = Math.min(started, now);
  const expiresAt = from + TRIAL_DAYS * DAY_SECONDS;
  const summariesLeft = Math.max(0, TRIAL_SUMMARIES - used);
  const daysLeft = Math.max(0, Math.ceil((expiresAt - now) / DAY_SECONDS));

  if (ended > 0 || now >= expiresAt || summariesLeft === 0) {
    return {
      status: 'ended',
      daysLeft: 0,
      summariesLeft,
      startedAt: started,
      endedAt: ended > 0 ? ended : Math.min(now, expiresAt),
      used,
      // The cap is reported first when both have run out, because it is the one the person
      // actually experienced — they watched the third summary get written.
      endedBecause: summariesLeft === 0 ? 'summaries' : 'time',
    };
  }

  return {
    status: 'active',
    daysLeft,
    summariesLeft,
    startedAt: started,
    endedAt: 0,
    used,
    endedBecause: null,
  };
}

/**
 * What the trial is doing right now.
 *
 * Ending is written down as well as computed. The stamp is what the rest of the app — including
 * the native side, which cannot call into JS — can read without re-deriving the rule, and it is
 * what stops a lapsed trial flickering back to life for a few seconds after a clock correction.
 */
export async function trialState(): Promise<TrialState> {
  const [started, used, ended, now] = await Promise.all([
    db.getSetting(KEY_STARTED).then(int).catch(() => 0),
    db.getSetting(KEY_USED).then(int).catch(() => 0),
    db.getSetting(KEY_ENDED).then(int).catch(() => 0),
    monotonicNow(),
  ]);

  const state = shape(started, used, ended, now);
  if (state.status === 'ended' && ended === 0) {
    await db.setSetting(KEY_ENDED, String(state.endedAt)).catch(() => {});
  }
  return state;
}

/**
 * Begin the trial. Idempotent, and deliberately so.
 *
 * A second tap on "Start the free trial" — from the paywall, from Settings, from a re-install that
 * restored a backup — returns the trial already running rather than restarting the clock. There is
 * exactly one place a trial can begin, and it is the absence of a start stamp.
 */
export async function startTrial(): Promise<TrialState> {
  const existing = await trialState();
  if (existing.status !== 'unstarted') return existing;

  const now = await monotonicNow();
  await db.setSetting(KEY_STARTED, String(now));
  await db.setSetting(KEY_USED, '0');
  await db.setSetting(KEY_ENDED, '0');
  return shape(now, 0, 0, now);
}

/**
 * Count one prose summary against the trial.
 *
 * Called after a summary has actually been written, never before: a model that failed to load, or
 * a meeting the user cancelled half way, must not cost one of three. A subscriber's summaries
 * never count either — if they later cancel, the trial they never used is still theirs.
 */
export async function noteTrialSummary(): Promise<TrialState> {
  const state = await trialState();
  if (state.status !== 'active') return state;

  const status = await Licence.status().catch(() => null);
  if (status?.paid) return state;

  const used = state.used + 1;
  await db.setSetting(KEY_USED, String(used));
  const now = await monotonicNow();
  const next = shape(state.startedAt, used, 0, now);
  if (next.status === 'ended') await db.setSetting(KEY_ENDED, String(next.endedAt)).catch(() => {});
  return next;
}

export interface Entitlement {
  /** May the paid features run at all — bought or borrowed. */
  paid: boolean;
  /** True when the only thing granting it is the trial, which changes what the screens say. */
  viaTrial: boolean;
  trial: TrialState;
  licence: LicenceStatus | null;
}

/**
 * The one question every screen in this lane actually asks.
 *
 * Note what this is NOT: enforcement. Narrator refuses to run without an entitlement natively,
 * where a patched JS bundle cannot reach it, and that remains the only thing standing between a
 * free user and the model. This decides what the UI is allowed to SAY, and nothing more — which
 * is the same division the licence module has always drawn.
 */
export async function entitlement(): Promise<Entitlement> {
  const [licence, trial] = await Promise.all([
    Licence.status().catch(() => null),
    trialState(),
  ]);
  const bought = Boolean(licence?.paid);
  const borrowed = trial.status === 'active';
  return { paid: bought || borrowed, viaTrial: !bought && borrowed, trial, licence };
}

/**
 * Whether this is the moment to offer Pro.
 *
 * Once, on the first meeting that finished processing — the only point at which somebody has seen
 * what the app does and can judge what the paid half would add. Never to a subscriber, never to
 * somebody who already made this decision by starting the trial, and never twice, because the
 * second showing is not persuasion, it is a nag, and this app's entire pitch is that it does not
 * behave like that.
 */
export async function shouldOfferPaywall(): Promise<boolean> {
  const seen = int(await db.getSetting(KEY_PAYWALL_SEEN).catch(() => null));
  if (seen > 0) return false;
  const { licence, trial } = await entitlement();
  if (licence?.paid) return false;
  return trial.status === 'unstarted';
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
  /** Only `paid` is read: it is already true for a subscriber OR a running trial. */
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
export const PRO_MODEL_IDS: readonly string[] = ['whisper-small'];

export function isProModel(m: { id: string; needsSubscription: boolean }): boolean {
  return m.needsSubscription || PRO_MODEL_IDS.includes(m.id);
}
