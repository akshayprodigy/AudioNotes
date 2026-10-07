import fs from 'fs';
import path from 'path';
import {
  ATTRIBUTION,
  DATE_NOT_GIVEN,
  DONE,
  NEEDS_LOOK,
  OWNER_NOT_SET,
  segmentLine,
} from '../markers';

const kotlin = fs.readFileSync(
  path.resolve(__dirname, '../../../android/app/src/main/java/com/innocorelabs/verbale/pipeline/ShareDocument.kt'),
  'utf8',
);
const constIn = (name: string) => {
  const m = kotlin.match(new RegExp(`const val ${name} = "([^"]*)"`));
  if (!m) throw new Error(`ShareDocument.kt no longer defines ${name}`);
  return m[1];
};

describe('the words are the ones the builder writes', () => {
  it('matches ShareDocument.kt, constant for constant', () => {
    expect(OWNER_NOT_SET).toBe(constIn('OWNER_NOT_SET'));
    expect(DATE_NOT_GIVEN).toBe(constIn('DATE_NOT_GIVEN'));
    expect(NEEDS_LOOK).toBe(constIn('NEEDS_LOOK'));
    expect(DONE).toBe(constIn('DONE'));
    expect(ATTRIBUTION).toBe(constIn('ATTRIBUTION'));
  });

  it('the attribution is exactly the promised line', () => {
    expect(ATTRIBUTION).toBe('Created with Verbale — private meeting notes');
  });
});

describe('segmentLine', () => {
  it('draws the flags after an item apart from its sentence', () => {
    expect(segmentLine('- [1:01] Book the room · Owner not set · No date given')).toEqual([
      { text: '- [1:01] Book the room', kind: 'plain' },
      { text: ' · ', kind: 'plain' },
      { text: 'Owner not set', kind: 'unresolved' },
      { text: ' · ', kind: 'plain' },
      { text: 'No date given', kind: 'unresolved' },
    ]);
  });

  it('keeps the model labels plain and marks Needs a look and Done', () => {
    const segs = segmentLine('  - [0:05] Send the deck — Priya · Request · Needs a look · Done');
    expect(segs.map(g => [g.text, g.kind])).toEqual([
      ['  - [0:05] Send the deck — Priya · Request', 'plain'],
      [' · ', 'plain'],
      ['Needs a look', 'unresolved'],
      [' · ', 'plain'],
      ['Done', 'done'],
    ]);
  });

  it('leaves a line with no flags whole', () => {
    const l = '- [1:01] Send the report — Priya (due Friday)';
    expect(segmentLine(l)).toEqual([{ text: l, kind: 'plain' }]);
  });

  it('never dresses a spoken word in the transcript as a flag', () => {
    for (const l of ['**Ravi:** Owner not set · Done', 'Done', 'Owner not set', 'Priya: it is Done']) {
      expect(segmentLine(l).every(g => g.kind === 'plain')).toBe(true);
    }
  });

  it('a flag in the middle of a sentence is not a flag', () => {
    const l = '- Owner not set · Book the room';
    expect(segmentLine(l).every(g => g.kind === 'plain')).toBe(true);
  });

  it('in the PDF preview a line of nothing but flags is drawn as flags', () => {
    expect(segmentLine('Owner not set · No date given', true).filter(g => g.kind === 'unresolved')).toHaveLength(2);
    expect(segmentLine('Done', true)).toEqual([{ text: 'Done', kind: 'done' }]);
    // ...and only there: the same line in a text preview is just text.
    expect(segmentLine('Owner not set · No date given', false).every(g => g.kind === 'plain')).toBe(true);
  });

  it('recognises the attribution, with or without Markdown emphasis', () => {
    expect(segmentLine(ATTRIBUTION)[0].kind).toBe('credit');
    expect(segmentLine(`*${ATTRIBUTION}*`)[0].kind).toBe('credit');
  });
});
