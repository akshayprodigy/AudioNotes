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

  it.each(golden.cases.map(c => [c.said, c.norm] as const))('"%s" → %s', (said, norm) => {
    expect(resolveDay(said, golden.meetingAt, golden.timeZone)).toBe(norm);
  });
});
