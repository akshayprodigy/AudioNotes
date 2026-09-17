import fs from 'fs';
import path from 'path';
import { TEMPLATE_IDS, templateLabel } from '../meeting/templateLabels';

/**
 * What a meeting type wears on the Summary chip and the sheet that changes it. Shared with
 * TemplateLabelsTest.kt, which renders exports; the C++ side does not read labels at all — the
 * narrative it writes never names the type, only its sections.
 */
const golden = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../cpp/tests/golden/template_labels.json'), 'utf8'),
) as { cases: { id: string | null; label: string }[] };

describe('templateLabel', () => {
  it('has a table worth running', () => {
    expect(golden.cases.length).toBeGreaterThan(7);
  });

  it.each(golden.cases.map(c => [c.id ?? '(null)', c] as const))('%s', (_name, c) => {
    expect(templateLabel(c.id)).toBe(c.label);
  });

  it('lists the seven ids in table order, general first', () => {
    expect(TEMPLATE_IDS).toEqual([
      'general', 'standup', 'one_on_one', 'client', 'interview', 'lecture', 'site_walk',
    ]);
  });
});
