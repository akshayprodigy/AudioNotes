import fs from 'fs';
import path from 'path';
import { decideReview } from '../reviewRule';

/** The same table ReviewRuleTest.kt runs: the phone and the card must agree on every row. */
const golden = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../cpp/tests/golden/review_rule.json'), 'utf8'),
) as {
  cases: {
    name: string; kind: string; type: string; status: string; confidence: string; ownerKind: string;
    dateSaid: string; dateNorm: number | null; review: string; expect: string; reason: string | null;
  }[];
};

describe('ReviewRule (TS mirror)', () => {
  it('has a table worth running', () => {
    expect(golden.cases.length).toBeGreaterThan(8);
  });

  it.each(golden.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const d = decideReview({
      kind: c.kind, type: c.type, status: c.status, confidence: c.confidence, ownerKind: c.ownerKind,
      dateSaid: c.dateSaid || null, dateNorm: c.dateNorm, currentReview: c.review,
    });
    expect(d.review).toBe(c.expect);
    expect(d.reason).toBe(c.reason);
  });
});
