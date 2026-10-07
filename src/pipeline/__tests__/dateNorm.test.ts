import fs from 'fs';
import path from 'path';
import { resolveDay } from '../dateNorm';

/**
 * A spoken date phrase to a day, or null. The same table DateNormTest.kt runs — the phone writes
 * date_norm with the Kotlin one and the screen previews a fix with this one; a row where they
 * disagree is a person shown a different Friday than the record holds.
 */
const golden = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../cpp/tests/golden/date_norm.json'), 'utf8'),
) as { meetingAt: number; timeZone: string; cases: { said: string; norm: string | null }[] };

describe('DateNorm (TS mirror)', () => {
  it('has a table worth running', () => {
    expect(golden.cases.length).toBeGreaterThan(10);
  });

  // F16c: "before <day>" is a deadline, not a day. It must stay unresolved so the review queue's
  // "date could not be pinned to a day" cue applies - a "before" that quietly resolved would show
  // a guessed day as a fact. Named separately from the table so a regression names itself.
  it('does not resolve "before ..." to a day, while "by ..." on the same words does', () => {
    for (const said of ['before Wednesday', 'before tomorrow', 'before next Friday', 'before the 21st']) {
      expect(resolveDay(said, golden.meetingAt, golden.timeZone)).toBeNull();
    }
    expect(resolveDay('by Wednesday', golden.meetingAt, golden.timeZone)).toBe('2026-09-23');
    expect(resolveDay('by tomorrow', golden.meetingAt, golden.timeZone)).toBe('2026-09-17');
  });

  it.each(golden.cases.map(c => [c.said, c.norm] as const))('"%s" → %s', (said, norm) => {
    expect(resolveDay(said, golden.meetingAt, golden.timeZone)).toBe(norm);
  });
});
