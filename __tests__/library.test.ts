import { normaliseTag } from '../src/db/queries';

/**
 * Tags are typed, not chosen from a list, so the same label reaches the database in several
 * spellings unless something folds them. Two filters each holding part of the answer is worse
 * than no filter at all — the user sees a short list and believes it.
 */
describe('normaliseTag', () => {
  it('folds the spellings of one tag together', () => {
    const base = normaliseTag('client');
    expect(normaliseTag('Client')).toBe(base);
    expect(normaliseTag('  client  ')).toBe(base);
    expect(normaliseTag('CLIENT')).toBe(base);
  });

  it('collapses internal whitespace, so "one to one" is one tag however it is typed', () => {
    expect(normaliseTag('one  to   one')).toBe('one to one');
  });

  it('rejects a tag that is only whitespace', () => {
    expect(normaliseTag('   ')).toBe('');
  });

  /** A pill has to fit on a phone. Anything longer is a note, and notes have somewhere else to go. */
  it('caps the length', () => {
    expect(normaliseTag('x'.repeat(80)).length).toBe(32);
  });

  it('leaves an ordinary tag alone', () => {
    expect(normaliseTag('standup')).toBe('standup');
  });
});
