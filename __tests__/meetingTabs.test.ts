import { parseProse, sentenceCase, splitAction } from '../src/screens/meeting/shared';
import { toTurns } from '../src/screens/meeting/TranscriptTab';
import type { Utterance } from '../src/pipeline/types';

/**
 * The four meeting tabs read their content through these. All of them exist because the data the
 * pipeline stores is not the shape a reader wants, and none of them may change what was said.
 */

describe('splitAction', () => {
  // minutes.ts stores an action as `<sentence> — <owner>` plus an optional `(due …)`. Rendered
  // raw that put "— Unassigned" on nearly every line of the worklist.
  it('separates the owner from the sentence', () => {
    expect(splitAction('Ana to draft the mapping table — Ana')).toEqual({
      text: 'Ana to draft the mapping table',
      owner: 'Ana',
      due: null,
    });
  });

  it('treats Unassigned as no owner at all', () => {
    expect(splitAction('Someone should check the barcode — Unassigned')).toEqual({
      text: 'Someone should check the barcode',
      owner: null,
      due: null,
    });
  });

  it('pulls out a due date', () => {
    expect(splitAction('This will need to be fixed — Ana (due by Friday)')).toEqual({
      text: 'This will need to be fixed',
      owner: 'Ana',
      due: 'due by Friday',
    });
  });

  it('keeps a due date when nobody owns the item', () => {
    expect(splitAction('Ship the thing — Unassigned (due by Friday)')).toEqual({
      text: 'Ship the thing',
      owner: null,
      due: 'due by Friday',
    });
  });

  // The sentence may contain a dash of its own; the suffix is whatever was appended last.
  it('splits on the last separator, not the first', () => {
    expect(splitAction('Ship it — and mean it — Ana').text).toBe('Ship it — and mean it');
  });

  it('leaves text with no suffix alone', () => {
    expect(splitAction('Nothing was appended here')).toEqual({
      text: 'Nothing was appended here',
      owner: null,
      due: null,
    });
  });
});

describe('sentenceCase', () => {
  // Extraction cuts at boundaries the ASR did not always get right, so items begin mid-clause.
  it('lifts the opening letter', () => {
    expect(sentenceCase('the patient party that this is an orthopedic case')).toBe(
      'The patient party that this is an orthopedic case',
    );
  });

  it('leaves the rest of the words exactly as they were said', () => {
    expect(sentenceCase('sonar reception person it is NOT possible')).toBe(
      'Sonar reception person it is NOT possible',
    );
  });

  it('is a no-op on empty text', () => {
    expect(sentenceCase('')).toBe('');
  });
});

describe('parseProse', () => {
  // The model writes bullets as literal "- " lines; one <Text> renders those as stray dashes.
  it('splits bullets out of the paragraph flow', () => {
    expect(parseProse('The group met:\n\n- First thing.\n- Second thing.')).toEqual([
      { kind: 'p', text: 'The group met:' },
      { kind: 'li', text: 'First thing.' },
      { kind: 'li', text: 'Second thing.' },
    ]);
  });

  it('joins hard-wrapped lines into one paragraph', () => {
    expect(parseProse('The group met\nand then agreed.')).toEqual([
      { kind: 'p', text: 'The group met and then agreed.' },
    ]);
  });

  it('keeps a blank line as a paragraph break', () => {
    expect(parseProse('One.\n\nTwo.')).toEqual([
      { kind: 'p', text: 'One.' },
      { kind: 'p', text: 'Two.' },
    ]);
  });

  it('accepts the other bullet glyphs', () => {
    expect(parseProse('* Star.\n• Dot.')).toEqual([
      { kind: 'li', text: 'Star.' },
      { kind: 'li', text: 'Dot.' },
    ]);
  });
});

describe('toTurns', () => {
  const names = new Map([
    ['s1', 'Speaker 1'],
    ['s2', 'Speaker 2'],
  ]);
  const idx = new Map([
    ['s1', 0],
    ['s2', 1],
  ]);
  const u = (id: string, speakerId: string, startMs: number, text: string): Utterance => ({
    id,
    meetingId: 'm',
    startMs,
    endMs: startMs + 1000,
    speakerId,
    text,
  });

  it('gathers a run by one speaker into a single turn', () => {
    const turns = toTurns(
      [u('a', 's1', 0, 'One.'), u('a2', 's1', 1500, 'Two.'), u('b', 's2', 3000, 'Three.')],
      names,
      idx,
    );
    expect(turns).toHaveLength(2);
    expect(turns[0].lines).toEqual(['One.', 'Two.']);
    expect(turns[1].lines).toEqual(['Three.']);
    expect(turns[1].who).toBe('Speaker 2');
  });

  // A turn is the unit FlatList virtualises. Left unbounded, an eighteen-minute monologue becomes
  // one enormous row and windowing stops doing anything.
  it('caps how long one turn can run', () => {
    const many = Array.from({ length: 20 }, (_, i) => u(`u${i}`, 's1', i * 1000, `Line ${i}.`));
    const turns = toTurns(many, names, idx);
    expect(turns.length).toBeGreaterThan(1);
    for (const t of turns) expect(t.lines.length).toBeLessThanOrEqual(8);
  });

  it('starts a new turn after a long pause by the same speaker', () => {
    const turns = toTurns([u('a', 's1', 0, 'Before.'), u('b', 's1', 60_000, 'After.')], names, idx);
    expect(turns).toHaveLength(2);
    expect(turns[1].startMs).toBe(60_000);
  });

  it('drops utterances with no words rather than showing an empty bubble', () => {
    const turns = toTurns([u('a', 's1', 0, '   '), u('b', 's1', 1000, 'Real.')], names, idx);
    expect(turns).toHaveLength(1);
    expect(turns[0].lines).toEqual(['Real.']);
  });
});
