import { countsExcluding, threadLine } from '../threadData';
import type { ThreadResult } from '../../pipeline/types';

describe('threadLine', () => {
  test('formats the counts', () => {
    expect(threadLine('weekly', 2, 3)).toBe('weekly: 2 open · 3 decisions');
  });

  test('singulars: "1 open", "1 decision"', () => {
    expect(threadLine('weekly', 1, 1)).toBe('weekly: 1 open · 1 decision');
  });

  test('zero counts read as plural decisions, singular-invariant open', () => {
    expect(threadLine('weekly', 0, 0)).toBe('weekly: 0 open · 0 decisions');
  });
});

function fixture(): Extract<ThreadResult, { tag: string }> {
  return {
    tag: 'ops',
    meetings: [
      { id: 'm3', title: 'Ops weekly, 17 Sep', createdAt: 3, template: null },
      { id: 'm2', title: 'Ops weekly, 10 Sep', createdAt: 2, template: null },
      { id: 'm1', title: 'Ops weekly, 3 Sep', createdAt: 1, template: null },
    ],
    open: [
      { itemId: 'a1', meetingId: 'm2', meetingTitle: 'Ops weekly', meetingAt: 2, content: 'Priya to draft', itemType: null, status: null, dateNorm: null },
      { itemId: 'a2', meetingId: 'm3', meetingTitle: 'Ops weekly', meetingAt: 3, content: "This meeting's own action", itemType: null, status: null, dateNorm: null },
    ],
    decisions: [
      { itemId: 'd1', meetingId: 'm1', meetingTitle: 'Ops weekly', meetingAt: 1, content: 'Vendor codes will be six digits.', itemType: null, status: null, changes: null },
      { itemId: 'd2', meetingId: 'm2', meetingTitle: 'Ops weekly', meetingAt: 2, content: 'Existing vendors keep their old codes.', itemType: null, status: null, changes: { itemId: 'd1', content: 'Vendor codes will be six digits.', meetingAt: 1 } },
      { itemId: 'd3', meetingId: 'm3', meetingTitle: 'Ops weekly', meetingAt: 3, content: "This meeting's own decision", itemType: null, status: null, changes: null },
    ],
  };
}

describe('countsExcluding', () => {
  test('drops this meeting\'s own rows from both counts', () => {
    expect(countsExcluding('m3', fixture())).toEqual({ open: 1, decisions: 2 });
  });

  test('a different meeting in the thread keeps its own rows counted', () => {
    expect(countsExcluding('m1', fixture())).toEqual({ open: 2, decisions: 2 });
  });

  test('null when the thread has no other meeting', () => {
    const solo: Extract<ThreadResult, { tag: string }> = {
      tag: 'solo',
      meetings: [{ id: 'only', title: 'One meeting', createdAt: 1, template: null }],
      open: [],
      decisions: [],
    };
    expect(countsExcluding('only', solo)).toBeNull();
  });

  test('null on a NOT_PRO refusal', () => {
    expect(countsExcluding('m1', { refusal: 'NOT_PRO' })).toBeNull();
  });
});
