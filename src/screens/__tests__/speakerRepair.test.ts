import { linesForScope, nextSpeakerName } from '../meeting/speakerRepair';

const turn = { parts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] };

/** Which lines a reassignment reaches. The split and the merge are both scopes of this. */
describe('linesForScope', () => {
  it('just this line', () => {
    expect(linesForScope(turn, 'b', 'line')).toEqual(['b']);
  });
  it('from here to the end of the turn — the split', () => {
    expect(linesForScope(turn, 'b', 'rest')).toEqual(['b', 'c', 'd']);
    expect(linesForScope(turn, 'd', 'rest')).toEqual(['d']);
    expect(linesForScope(turn, 'a', 'rest')).toEqual(['a', 'b', 'c', 'd']);
  });
  it('the whole turn — the merge', () => {
    expect(linesForScope(turn, 'c', 'turn')).toEqual(['a', 'b', 'c', 'd']);
  });
  it('a line the turn does not hold reaches nothing', () => {
    expect(linesForScope(turn, 'zz', 'rest')).toEqual([]);
    expect(linesForScope(turn, 'zz', 'line')).toEqual([]);
  });
});

/** A blank name for "Someone new" becomes the next machine-style name, never a duplicate. */
describe('nextSpeakerName', () => {
  it('numbers past every existing Speaker N', () => {
    expect(nextSpeakerName(['Speaker 1', 'Speaker 2'])).toBe('Speaker 3');
    expect(nextSpeakerName(['Priya', 'Speaker 4'])).toBe('Speaker 5');
    expect(nextSpeakerName([])).toBe('Speaker 1');
  });
});
