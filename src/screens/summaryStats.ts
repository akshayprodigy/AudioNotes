import type { AllowanceStatus } from '../native/NativeLicence';
import { formatReset } from '../billing/allowanceCopy';

/**
 * What the Library's summary strip says, as plain data so the wording can be tested without a
 * screen. The strip replaced one run-on line ("19 saved · 15 min captured") plus the allowance
 * sentence, which wrapped into four ragged lines in the narrow column beside the header buttons.
 */

export interface StatPart {
  value: string;
  unit?: string;
}

export interface Stat {
  key: 'saved' | 'captured' | 'free' | 'actions';
  label: string;
  parts: StatPart[];
  /** A small line under the figure; only the allowance has one. */
  caption?: string;
  /** The allowance is spent. Drawn in the calm warning ink, never danger: it is a fact, not a fault. */
  spent?: boolean;
  /** The whole stat as a sentence, for a screen reader that reads the strip as one thing. */
  spoken: string;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `'2026-11-01'` to `'1 Nov'`; anything unreadable falls back to the long form. */
export function shortReset(resetsOn: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(resetsOn);
  if (!m) return formatReset(resetsOn);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return formatReset(resetsOn);
  return `${day} ${MONTHS_SHORT[month - 1]}`;
}

/** Whole minutes as "15 min", "1 h" or "1 h 5 min". */
export function capturedParts(totalMin: number): StatPart[] {
  const min = Math.max(0, Math.round(totalMin));
  if (min < 60) return [{ value: String(min), unit: 'min' }];
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0
    ? [{ value: String(h), unit: 'h' }]
    : [{ value: String(h), unit: 'h' }, { value: String(rest), unit: 'min' }];
}

const speakParts = (parts: StatPart[]) => parts.map(p => `${p.value} ${p.unit === 'h' ? (p.value === '1' ? 'hour' : 'hours') : p.unit ?? ''}`.trim()).join(' ');

/**
 * The strip's cells. Saved and captured always; the allowance only on a Free phone once native
 * has answered (Pro never sees allowance copy). The caller passes the person's own meetings only:
 * the sample is neither saved nor captured.
 */
export function summaryStats(saved: number, capturedMin: number, allowance: AllowanceStatus | null, openActions: number | null = null): Stat[] {
  const captured = capturedParts(capturedMin);
  const out: Stat[] = [
    {
      key: 'saved',
      label: 'SAVED',
      parts: [{ value: String(saved) }],
      spoken: `${saved} ${saved === 1 ? 'meeting' : 'meetings'} saved`,
    },
    {
      key: 'captured',
      label: 'CAPTURED',
      parts: captured,
      spoken: `${speakParts(captured)} captured`,
    },
  ];
  if (allowance && !allowance.paid) {
    out.push({
      key: 'free',
      label: 'FREE LEFT',
      parts: [{ value: String(allowance.remaining), unit: `of ${allowance.limit}` }],
      caption: `Resets ${shortReset(allowance.resetsOn)}`,
      spent: allowance.remaining <= 0,
      spoken: `${allowance.remaining} of ${allowance.limit} free meetings left, resets ${formatReset(allowance.resetsOn)}`,
    });
  }
  // Pro's third cell: the open actions, where Free counts its meetings. The strip opens the
  // tracker, so the header needs no Actions button (founder, 22 Oct).
  if (openActions !== null) {
    out.push({
      key: 'actions',
      label: 'ACTIONS',
      parts: [{ value: String(openActions), unit: 'open' }],
      spoken: `${openActions} open ${openActions === 1 ? 'action' : 'actions'}`,
    });
  }
  return out;
}
