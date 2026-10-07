import {
  buildFollowUp,
  dayStart,
  dueActions,
  openDecisions,
  previewOf,
  reviewMeetings,
} from '../followUpData';
import type { ActionRow, DecisionRow, ReviewItemRow } from '../../pipeline/types';

jest.mock('../../db/queries');

/** 7 Oct 2026, as the shape date_norm stores: the calendar day at UTC midnight. */
const TODAY = Date.UTC(2026, 9, 7);
const DAY = 86_400_000;

const action = (over: Partial<ActionRow> = {}): ActionRow => ({
  meetingId: 'm1',
  meetingTitle: 'Standup',
  createdAt: 1000,
  id: 'a1',
  content: 'Send the report — Priya (due Friday)',
  ownerJson: null,
  source: 'rule',
  anchorStartMs: 5000,
  dateNorm: TODAY,
  done: false,
  ...over,
});
const decision = (over: Partial<DecisionRow> = {}): DecisionRow => ({
  meetingId: 'm1',
  meetingTitle: 'Standup',
  createdAt: 1000,
  id: 'd1',
  content: 'We will use the agency quote',
  status: 'open',
  itemType: 'agreement',
  anchorStartMs: 9000,
  ...over,
});
const review = (over: Partial<ReviewItemRow> = {}): ReviewItemRow => ({
  meetingId: 'm1',
  meetingTitle: 'Standup',
  createdAt: 1000,
  id: 'r1',
  content: 'Book the review',
  ...over,
});

describe('dayStart', () => {
  it('is the phone calendar day as UTC midnight, the shape date_norm holds', () => {
    const noon = new Date(2026, 9, 7, 12, 30).getTime();
    expect(dayStart(noon)).toBe(TODAY);
    const lateNight = new Date(2026, 9, 7, 23, 59).getTime();
    expect(dayStart(lateNight)).toBe(TODAY);
  });
});

describe('dueActions', () => {
  it('counts an action due today, and one due before today', () => {
    const rows = [action({ id: 'today' }), action({ id: 'old', dateNorm: TODAY - 3 * DAY })];
    expect(dueActions(rows, TODAY).map(r => r.id).sort()).toEqual(['old', 'today']);
  });

  it('does not count tomorrow', () => {
    expect(dueActions([action({ dateNorm: TODAY + DAY })], TODAY)).toEqual([]);
  });

  it('never counts a ticked action', () => {
    expect(dueActions([action({ done: true })], TODAY)).toEqual([]);
  });

  it('does not guess a day for a phrase that was not normalised: "before Wednesday" is not overdue', () => {
    const rows = [
      action({ id: 'phrase', content: 'Book it — Sam (due before Wednesday)', dateNorm: null }),
      action({ id: 'never-read', dateNorm: undefined }),
    ];
    expect(dueActions(rows, TODAY)).toEqual([]);
  });

  it('keeps a due date of the epoch itself (0 is a day, not "none")', () => {
    expect(dueActions([action({ dateNorm: 0 })], TODAY)).toHaveLength(1);
  });

  it('leaves the sample meeting out', () => {
    expect(dueActions([action({ meetingId: 'sample-meeting-v1' })], TODAY)).toEqual([]);
  });

  it('is relative to the injected day, not to the clock', () => {
    const r = [action({ dateNorm: TODAY + 2 * DAY })];
    expect(dueActions(r, TODAY)).toHaveLength(0);
    expect(dueActions(r, TODAY + 2 * DAY)).toHaveLength(1);
  });

  it('puts the most overdue first', () => {
    const rows = [
      action({ id: 'b', dateNorm: TODAY - DAY }),
      action({ id: 'a', dateNorm: TODAY - 5 * DAY }),
      action({ id: 'c', dateNorm: TODAY }),
    ];
    expect(dueActions(rows, TODAY).map(r => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('openDecisions', () => {
  it('counts open and qualified', () => {
    const rows = [decision({ id: 'o', status: 'open' }), decision({ id: 'q', status: 'qualified' })];
    expect(openDecisions(rows).map(r => r.id)).toEqual(['o', 'q']);
  });

  it('does not count a contradicted or a withdrawn decision: those are settled', () => {
    const rows = [decision({ status: 'contradicted' }), decision({ status: 'withdrawn' })];
    expect(openDecisions(rows)).toEqual([]);
  });

  it('does not count a decision the classifier never read (status null): that would be a guess', () => {
    expect(openDecisions([decision({ status: null, itemType: null })])).toEqual([]);
  });

  it('leaves the sample meeting out', () => {
    expect(openDecisions([decision({ meetingId: 'sample-meeting-v1' })])).toEqual([]);
  });
});

describe('reviewMeetings', () => {
  it('groups the queue by meeting with a count and the first item', () => {
    const rows = [
      review({ id: 'r1', meetingId: 'm2', meetingTitle: 'Planning', content: 'First' }),
      review({ id: 'r2', meetingId: 'm2', content: 'Second' }),
      review({ id: 'r3', meetingId: 'm1', meetingTitle: 'Standup', content: 'Other' }),
    ];
    expect(reviewMeetings(rows)).toEqual([
      { meetingId: 'm2', meetingTitle: 'Planning', createdAt: 1000, count: 2, firstText: 'First' },
      { meetingId: 'm1', meetingTitle: 'Standup', createdAt: 1000, count: 1, firstText: 'Other' },
    ]);
  });

  it('leaves the sample meeting out', () => {
    expect(reviewMeetings([review({ meetingId: 'sample-meeting-v1' })])).toEqual([]);
  });
});

describe('previewOf', () => {
  it('drops the owner and due tail and capitalises', () => {
    expect(previewOf('send the report — Priya (due Friday)')).toBe('Send the report');
  });
});

describe('buildFollowUp', () => {
  it('answers all three questions from one set of rows', () => {
    const f = buildFollowUp([action()], [decision()], [review()], TODAY);
    expect([f.due.length, f.decisions.length, f.review.length]).toEqual([1, 1, 1]);
  });
});
