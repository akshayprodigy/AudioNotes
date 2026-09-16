import fs from 'fs';
import path from 'path';
import { labelSuffix, labelsFor } from '../meeting/recordLabels';

/**
 * What a typed item wears. The defects it guards: a free-tier item (no record) growing labels
 * it never earned, "Open" shown as if it were news, and a day label the phone and the screen
 * disagree about. The table is shared with RecordLabelsTest.kt, which renders the exports.
 */
const golden = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../cpp/tests/golden/record_labels.json'), 'utf8'),
) as {
  cases: {
    name: string; itemType: string | null; status: string | null; dateNorm: number | null;
    type: string | null; statusLabel: string | null; day: string | null; suffix: string;
  }[];
};

describe('labelsFor', () => {
  it('has a table worth running', () => {
    expect(golden.cases.length).toBeGreaterThan(7);
  });

  it.each(golden.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const r = { itemType: c.itemType, status: c.status, dateNorm: c.dateNorm };
    const l = labelsFor(r);
    expect(l.type ?? null).toBe(c.type);
    expect(l.status ?? null).toBe(c.statusLabel);
    expect(l.day ?? null).toBe(c.day);
    expect(labelSuffix(r)).toBe(c.suffix);
  });

  it('shows nothing for an item nothing has read', () => {
    expect(labelsFor(null)).toEqual({});
    expect(labelSuffix(null)).toBe('');
  });
});
