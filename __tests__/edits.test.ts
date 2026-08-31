import {
  DOC_KEY,
  composeAction,
  editKey,
  editedText,
  isEdited,
  itemKey,
  minuteText,
  splitAction,
  toEditMap,
} from '../src/screens/meeting/shared';
import type { Edit, Minute } from '../src/pipeline/types';

/**
 * Hand corrections, overlaid at render.
 *
 * Edits are a SIDE table rather than a rewrite of the text they correct, and everything here
 * follows from that one decision: ticked actions are keyed on a hash of the STORED minute text,
 * so rewriting it in place would untick every item the user had worked through, and reprocessing
 * would overwrite their words anyway because it owns the `rule` rows.
 */

const edit = (targetKind: Edit['targetKind'], targetKey: string, content: string): Edit => ({
  meetingId: 'm1',
  targetKind,
  targetKey,
  content,
  editedAt: 1,
});

describe('toEditMap', () => {
  it('keys on kind and target together', () => {
    const map = toEditMap([edit('minute', 'k1', 'Fixed.'), edit('utterance', 'k1', 'Misheard.')]);
    // Same target key, different kinds: a minute and an utterance must not collide.
    expect(map.get(editKey('minute', 'k1'))).toBe('Fixed.');
    expect(map.get(editKey('utterance', 'k1'))).toBe('Misheard.');
    expect(map.size).toBe(2);
  });
});

describe('editedText', () => {
  const map = toEditMap([
    edit('minute', 'k1', 'The corrected line.'),
    edit('summary', DOC_KEY, 'A summary somebody typed.'),
  ]);

  it('prefers the correction over what the pipeline wrote', () => {
    expect(editedText(map, 'minute', 'k1', 'The original line.')).toBe('The corrected line.');
  });

  it('falls through to the original where there is no correction', () => {
    expect(editedText(map, 'minute', 'k2', 'Untouched.')).toBe('Untouched.');
  });

  /**
   * A summary somebody typed on a phone that cannot run the model is still the summary of that
   * meeting; withholding it because no model wrote one would be absurd.
   */
  it('returns an edit that has no original at all', () => {
    expect(editedText(map, 'summary', DOC_KEY, undefined)).toBe('A summary somebody typed.');
  });

  it('reports nothing when there is neither', () => {
    expect(editedText(map, 'narrative', DOC_KEY, undefined)).toBeUndefined();
  });

  it('knows which lines carry a correction', () => {
    expect(isEdited(map, 'minute', 'k1')).toBe(true);
    expect(isEdited(map, 'minute', 'k2')).toBe(false);
  });
});

/**
 * The invariant the whole side-table design exists to protect: correcting an item must not move
 * the key its tick hangs on.
 */
describe('the edit key is the stored text, not the shown text', () => {
  const stored = 'We need to fix the barcode scanner — Unassigned';

  it('keeps the tick key stable when a correction is made', () => {
    const before = itemKey(stored);
    // What the user sees, and then edits, is the split form without the owner suffix.
    expect(splitAction(stored).text).toBe('We need to fix the barcode scanner');
    // The key must still come from the stored column.
    expect(itemKey(stored)).toBe(before);
    expect(itemKey(splitAction(stored).text)).not.toBe(before);
  });
});

describe('minuteText', () => {
  const m = (content: string): Minute => ({
    id: 'x',
    meetingId: 'm1',
    kind: 'action',
    content,
    source: 'user',
  });

  it('leaves ordinary text alone', () => {
    expect(minuteText(m('Send the report.'))).toBe('Send the report.');
  });

  /**
   * addUserMinute briefly ran its content through JSON.stringify, which put literal quotation
   * marks around every hand-written item. The writer is fixed; this unwraps the rows written
   * while it was not.
   */
  it('unwraps a row written by the double-encoding build', () => {
    expect(minuteText(m('"Send the report."'))).toBe('Send the report.');
  });

  it('does not strip quotes from a genuinely quoted sentence', () => {
    expect(minuteText(m('"Ship it," she said.'))).toBe('"Ship it," she said.');
  });
});

describe('composeAction', () => {
  it('stores a typed action in the extractor’s own shape', () => {
    expect(composeAction('Send the deck', 'Priya')).toBe('Send the deck — Priya');
  });

  it('marks an unowned action the way the extractor does', () => {
    expect(composeAction('Send the deck', 'Unassigned')).toBe('Send the deck — Unassigned');
  });

  /** A round trip through the display parser must give back what was typed. */
  it('round-trips through splitAction', () => {
    const stored = composeAction('Send the deck', 'Priya');
    expect(splitAction(stored)).toEqual({ text: 'Send the deck', owner: 'Priya', due: null });
  });
});
