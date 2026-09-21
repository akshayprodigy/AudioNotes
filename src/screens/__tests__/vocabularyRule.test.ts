import fs from 'fs';
import path from 'path';
import { proposeRule } from '../meeting/vocabularyRule';

/**
 * What a correction offers to remember (Phase 5). The defects it guards: a rewrite or a dictated
 * line's new marks proposed as a "rule" that would then rewrite every later meeting; a mark
 * carried into `heard` so the rule never matches; two fixes fused into one nonsense pair.
 */
const golden = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../cpp/tests/golden/vocabulary_rule.json'), 'utf8'),
) as { cases: { name: string; before: string; after: string; expect: { heard: string; meant: string } | null }[] };

describe('proposeRule', () => {
  it('has a table worth running', () => {
    expect(golden.cases.length).toBeGreaterThan(12);
  });

  it.each(golden.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    expect(proposeRule(c.before, c.after)).toEqual(c.expect);
  });
});
