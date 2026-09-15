/**
 * A mark is a moment; a highlight is what was said there.
 *
 * The rule is small and this is the only place it is stated in tests: inside an utterance takes
 * that utterance; in a gap, the next utterance if it starts within GAP_MS (a mark is usually a
 * beat BEFORE the thing worth keeping); otherwise the time alone. The Kotlin export reader
 * mirrors the rule against the same three-turn fixture (ExportItemsTest).
 */
import { highlightsFor, GAP_MS } from '../meeting/highlights';
import type { Utterance } from '../../pipeline/types';

const u = (id: string, startMs: number, endMs: number, text: string): Utterance => ({
  id,
  meetingId: 'm',
  speakerId: 'S1',
  startMs,
  endMs,
  text,
});
const utts = [
  u('a', 1000, 4000, 'First thing.'),
  u('b', 9000, 12000, 'Second thing.'),
  u('c', 30000, 33000, 'Third.'),
];

describe('highlightsFor', () => {
  test('a mark inside an utterance takes that utterance', () => {
    expect(highlightsFor([{ id: 1, atMs: 2500 }], utts)).toEqual([
      { id: 1, atMs: 2500, text: 'First thing.', anchorStartMs: 1000 },
    ]);
  });

  test('a mark in a gap takes the next utterance within the gap allowance', () => {
    expect(highlightsFor([{ id: 2, atMs: 6000 }], utts)[0]).toMatchObject({
      text: 'Second thing.',
      anchorStartMs: 9000,
    });
  });

  test('a mark with nothing near it keeps its time and no words', () => {
    // 2 s after "Second thing." ends, 16 s before "Third." starts: past GAP_MS.
    expect(GAP_MS).toBe(15000);
    expect(highlightsFor([{ id: 3, atMs: 14000 }], utts)[0]).toMatchObject({
      text: null,
      anchorStartMs: 14000,
    });
  });

  test('marks come back in recording order regardless of tap order', () => {
    const out = highlightsFor([{ id: 9, atMs: 31000 }, { id: 8, atMs: 1500 }], utts);
    expect(out.map(h => h.id)).toEqual([8, 9]);
  });

  test('a mark before the first word waits for it', () => {
    expect(highlightsFor([{ id: 4, atMs: 0 }], utts)[0]).toMatchObject({
      text: 'First thing.',
      anchorStartMs: 1000,
    });
  });
});
