/**
 * Phase 5 (custom vocabulary): what "Correct the words" offers to remember.
 *
 * When the corrected line differs from the recognised one by ONE contiguous run of one to three
 * words on each side — "in over" → "Innova" — that pair is a rule worth asking about once. Anything
 * else is a correction and nothing more: a rewrite, an inserted or deleted word, a mark added along
 * the line (dictation's own habit), two fixes in one line. Asked in those cases, the question would
 * be wrong more often than right, and a wrong "Yes" rewrites every meeting after it.
 *
 * Pure, so the golden pins it (cpp/tests/golden/vocabulary_rule.json).
 */
export interface RuleProposal {
  heard: string;
  meant: string;
}

const MAX_WORDS = 3;

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/** "Innova," → "Innova": the mark belongs to the line, not to the word. */
const bare = (s: string) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

export function proposeRule(before: string, after: string): RuleProposal | null {
  const a = words(before);
  const b = words(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const heard = bare(a.slice(pre, a.length - suf).join(' '));
  const meant = bare(b.slice(pre, b.length - suf).join(' '));
  if (!heard || !meant || heard === meant) return null;
  if (words(heard).length > MAX_WORDS || words(meant).length > MAX_WORDS) return null;
  return { heard, meant };
}
