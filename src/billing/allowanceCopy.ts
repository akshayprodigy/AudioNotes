import type { AllowanceStatus } from '../native/NativeLicence';

/**
 * Every word the app says about the Free allowance, in one place so the surfaces cannot drift and
 * one test file can pin them (plan section 3, addendum R8). Pure: no native calls, no store.
 *
 * Pro never sees any of this: [statusLine] and [settingsValue] are where "paid" is decided.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * `'2026-11-01'` to `'1 November'`. Not Intl: Hermes' locale support varies by build, and a date
 * that renders differently on the founder's phone and a reviewer's is the kind of bug nobody
 * reports. Anything unreadable comes back unchanged.
 */
export function formatReset(resetsOn: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(resetsOn);
  if (!m) return resetsOn;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return resetsOn;
  return `${day} ${MONTHS[month - 1]}`;
}

/** The standing description of the Free tier. */
export const freeHeadline = 'Free: 5 meetings each month · up to 1 hour each.';

/** The language statement, said wherever the app first asks somebody to record. Launch is English only. */
export const englishOnly = 'Verbale works in English.';

/**
 * The one short card before the first real recording: the language, then the Free allowance.
 * Pro (`paid` true) gets the language alone, because Pro never sees allowance copy. `null` means
 * native has not answered yet, and says the language alone rather than state a limit that may not
 * apply.
 */
export function firstRecordingNote(paid: boolean | null): string {
  return paid === false ? `${englishOnly} ${freeHeadline}` : englishOnly;
}

/** One line of explanation, wherever the headline appears with room to spare (GAP-12). */
export const explainer = 'Imports and dictations count as meetings.';

/** "3 of 5 free meetings left · resets 1 November." */
export function remainingCopy(remaining: number, limit: number, resetsOn: string): string {
  return `${remaining} of ${limit} free meetings left · resets ${formatReset(resetsOn)}.`;
}

/** Shown when the month's meetings are used up. Saved work stays available, and says so. */
export function exhaustedCopy(resetsOn: string): string {
  return (
    "You've used your 5 free meetings this month. Your saved meetings are still available. " +
    `Get Pro for more meetings, or record again from ${formatReset(resetsOn)}.`
  );
}

/**
 * The Record screen's hint when the month's meetings are used up. The idle hint says "Tap to start
 * recording" and the card above it says you cannot - two statements that cannot both be true.
 */
export function exhaustedHint(resetsOn: string): string {
  return `Free meetings are used up until ${formatReset(resetsOn)}`;
}

/** The quiet line for Library, import and Record; null for Pro, and until native has answered. */
export function statusLine(s: AllowanceStatus | null): string | null {
  if (!s || s.paid) return null;
  return remainingCopy(s.remaining, s.limit, s.resetsOn);
}

/** The value half of Settings' "Free allowance" row; empty until native has answered. */
export function settingsValue(s: AllowanceStatus | null): string {
  if (!s) return '';
  if (s.paid) return 'Unlimited with Pro';
  return `${s.remaining} of ${s.limit} left · resets ${formatReset(s.resetsOn)}`;
}

export const finishRecordingFirst = 'Finish recording first';
export const finishImportFirst = 'Finish the import first';
export const importTooLong = 'That recording is longer than the 1 hour Free limit. Pro has no length limit.';

/**
 * What to tell somebody whose import was refused for a reason the allowance owns; null for any
 * other failure, which the caller words itself. `upgrade` means offer Pro alongside the line.
 */
export function importErrorCopy(
  code: string | undefined,
  message: string,
): { text: string; upgrade: boolean } | null {
  switch (code) {
    case 'allowance_exhausted':
      return { text: exhaustedCopy(message), upgrade: true };
    case 'import_too_long':
      return { text: importTooLong, upgrade: true };
    case 'recording_in_progress':
      return { text: finishRecordingFirst, upgrade: false };
    case 'import_in_progress':
      return { text: finishImportFirst, upgrade: false };
    default:
      return null;
  }
}

/** The one quiet line a Free phone sees under keyword search results (F09). Keyword search is Free. */
export const meaningSearchOffer =
  'Pro also searches by meaning, so a question finds the answer even when the words differ.';
