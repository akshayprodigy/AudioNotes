/**
 * A spoken date phrase resolved against the meeting's date, or honestly null.
 *
 * The mirror of DateNorm.kt; cpp/tests/golden/date_norm.json is the contract between the two.
 * The phone writes `date_norm` with the Kotlin one; the screen uses this one to show what a fix
 * would resolve to, and the two must never disagree about which day "Friday" is.
 *
 * All arithmetic is on the meeting's LOCAL calendar day in the given zone, read through Intl so
 * it is right on a phone whose zone is not the meeting's.
 */
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const NUMBERS: Record<string, number> = {
  one: 1, a: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const DROPPED_LEADS = new Set(['by', 'on', 'for', 'until', 'till']);

/** A calendar day, zone-free: the arithmetic happens here and only the ends touch a zone. */
interface Day { y: number; m: number; d: number }

function localDay(atMs: number, timeZone: string): Day {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(atMs));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

const toUtc = (day: Day) => Date.UTC(day.y, day.m - 1, day.d);
const fromUtc = (ms: number): Day => {
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
};
const plusDays = (day: Day, n: number) => fromUtc(toUtc(day) + n * 86_400_000);
const weekdayOf = (day: Day) => new Date(toUtc(day)).getUTCDay();
const isoDay = (day: Day) => `${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The first such weekday strictly after today; the same weekday means a week later. */
function coming(today: Day, weekday: number): Day {
  let d = plusDays(today, 1);
  while (weekdayOf(d) !== weekday) d = plusDays(d, 1);
  return d;
}

export function resolveDate(said: string, today: Day): Day | null {
  let words = said.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length && DROPPED_LEADS.has(words[0])) words = words.slice(1);
  if (words.length === 0) return null;
  const phrase = words.join(' ');

  if (phrase === 'today') return today;
  if (phrase === 'tomorrow') return plusDays(today, 1);
  if (phrase === 'end of the week' || phrase === 'end of week' || phrase === 'the end of the week') {
    return weekdayOf(today) === WEEKDAYS.friday ? today : coming(today, WEEKDAYS.friday);
  }
  if (words.length === 2 && words[0] === 'next' && words[1] in WEEKDAYS) return plusDays(coming(today, WEEKDAYS[words[1]]), 7);
  if (words.length === 2 && words[0] === 'this' && words[1] in WEEKDAYS) return coming(today, WEEKDAYS[words[1]]);
  if (words.length === 1 && words[0] in WEEKDAYS) return coming(today, WEEKDAYS[words[0]]);

  // "the 21st" / "the 3rd": this month, or next if it has passed — today's own date counts as
  // passed; nobody names today's date as a deadline.
  const ordinal = /^(?:the )?([0-9]{1,2})(?:st|nd|rd|th)$/.exec(phrase);
  if (ordinal) {
    const day = Number(ordinal[1]);
    if (day >= 1 && day <= 31) {
      if (day > today.d && day <= daysInMonth(today.y, today.m)) return { y: today.y, m: today.m, d: day };
      const ny = today.m === 12 ? today.y + 1 : today.y;
      const nm = today.m === 12 ? 1 : today.m + 1;
      return day <= daysInMonth(ny, nm) ? { y: ny, m: nm, d: day } : null;
    }
  }
  const inN = /^in ([a-z0-9]+) (day|days|week|weeks)$/.exec(phrase);
  if (inN) {
    const n = /^[0-9]+$/.test(inN[1]) ? Number(inN[1]) : NUMBERS[inN[1]];
    if (n === undefined) return null;
    return plusDays(today, inN[2].startsWith('week') ? n * 7 : n);
  }
  return null;
}

/** The resolved local day as YYYY-MM-DD, or null. The shape the golden table compares. */
export function resolveDay(said: string, meetingAtMs: number, timeZone: string): string | null {
  const d = resolveDate(said, localDay(meetingAtMs, timeZone));
  return d ? isoDay(d) : null;
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A day as the label the queue shows: "Fri 18 Sep". Fixed tables rather than Intl: ICU spells
 * September "Sept" in en-GB on some engines, and a label must read the same on every phone.
 * A number is a stored local midnight, read in UTC (see recordLabels); a string is YYYY-MM-DD.
 */
export function dayLabel(isoOrMs: string | number): string {
  const dt = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(`${isoOrMs}T00:00:00Z`);
  return `${WEEKDAY_SHORT[dt.getUTCDay()]} ${dt.getUTCDate()} ${MONTH_SHORT[dt.getUTCMonth()]}`;
}
