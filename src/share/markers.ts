/**
 * The words a shared document uses for what the meeting did not settle, and the one function that
 * finds them again in a line so the preview can draw them differently.
 *
 * The phrases are WRITTEN by `ShareDocument.kt` (the single builder behind the preview and every
 * file) and only RECOGNISED here. `markers.test.ts` reads that Kotlin file and fails if either side
 * changes a word, so the two cannot drift.
 */
export const OWNER_NOT_SET = 'Owner not set';
export const DATE_NOT_GIVEN = 'No date given';
export const NEEDS_LOOK = 'Needs a look';
export const DONE = 'Done';
export const ATTRIBUTION = 'Created with Verbale — private meeting notes';

/** What the meeting left open. The preview draws these apart from the sentence they follow. */
export const UNRESOLVED: readonly string[] = [OWNER_NOT_SET, DATE_NOT_GIVEN, NEEDS_LOOK];

export type Segment = { text: string; kind: 'plain' | 'unresolved' | 'done' | 'credit' };

const SEP = ' · ';
const BULLET = /^\s*(?:-|•)\s/;

function kindOf(flag: string): Segment['kind'] | null {
  if (UNRESOLVED.includes(flag)) return 'unresolved';
  if (flag === DONE) return 'done';
  return null;
}

/**
 * Take one line of a document apart into runs of one style each.
 *
 * Only two shapes are ever recognised, and both are shapes the builder writes and a person
 * speaking would not: an item line (a bullet) whose TAIL, after " · ", is a run of known flags; and,
 * in the PDF preview, a line made of nothing but flags (the PDF sets them on a line of their own).
 * Everything else is plain, so a spoken "Done" in the transcript is never dressed up as a flag.
 */
export function segmentLine(line: string, pdf = false): Segment[] {
  const bare = line.replace(/^\*|\*$/g, '');
  if (bare === ATTRIBUTION) return [{ text: line, kind: 'credit' }];

  const parts = line.split(SEP);
  const flagsOnly = pdf && parts.every(p => kindOf(p) !== null);
  if (flagsOnly) {
    return parts.flatMap((p, i) => [
      ...(i > 0 ? [{ text: SEP, kind: 'plain' as const }] : []),
      { text: p, kind: kindOf(p)! },
    ]);
  }
  if (!BULLET.test(line) || parts.length < 2) return [{ text: line, kind: 'plain' }];

  let i = parts.length;
  while (i > 1 && kindOf(parts[i - 1]) !== null) i--;
  if (i === parts.length) return [{ text: line, kind: 'plain' }];

  const out: Segment[] = [{ text: parts.slice(0, i).join(SEP), kind: 'plain' }];
  for (let j = i; j < parts.length; j++) {
    out.push({ text: SEP, kind: 'plain' }, { text: parts[j], kind: kindOf(parts[j])! });
  }
  return out;
}
