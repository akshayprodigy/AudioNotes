import { cardPreview, oneLine, previewOf, takeawayOf } from '../takeaway';
import type { Minute } from '../../../pipeline/types';

const minute = (kind: Minute['kind'], content: string, source: Minute['source'] = 'llm'): Minute => ({
  id: `${kind}-${source}`,
  meetingId: 'm1',
  kind,
  content,
  source,
});

describe('takeawayOf', () => {
  it('is the writer headline when there is one, whatever the rules found', () => {
    const t = takeawayOf({
      minutes: [minute('headline', 'The launch video goes ahead with the agency.')],
      decisions: ['We agreed to use the other agency.'],
      actions: [],
    });
    expect(t).toBe('The launch video goes ahead with the agency.');
  });

  it('is the rule summary lead on Free: what was decided, with no count', () => {
    const t = takeawayOf({
      minutes: [],
      decisions: ['We agreed to go with the agency quote of $4,500.', 'Captions wait until Friday.'],
      actions: ['I will send the quote — Priya (due Wednesday)'],
    });
    expect(t).toBe('Decided: We agreed to go with the agency quote of $4,500; Captions wait until Friday.');
    expect(t).not.toMatch(/\d+ (action|decision|open)/);
  });

  it('falls back to the first next step, without the owner suffix, when nothing was decided', () => {
    const t = takeawayOf({
      minutes: [],
      decisions: [],
      actions: ['Book the room — Unassigned', 'I will send the quote — Priya (due Wednesday)'],
    });
    // Owned actions lead; the suffix is not part of a sentence.
    expect(t).toBe('Next: I will send the quote; Book the room.');
  });

  it('is null, not a count, when there is nothing to lead with', () => {
    expect(takeawayOf({ minutes: [], decisions: [], actions: [] })).toBeNull();
  });

  it('ignores a blank headline and a headline that is not the writer or the person', () => {
    expect(takeawayOf({ minutes: [minute('headline', '   ')], decisions: [], actions: [] })).toBeNull();
  });

  it('is one concise line: clipped on a word boundary', () => {
    const long = 'We agreed ' + 'to keep going '.repeat(40);
    const t = takeawayOf({ minutes: [minute('headline', long)], decisions: [], actions: [] })!;
    expect(t.length).toBeLessThanOrEqual(221);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('oneLine', () => {
  it('collapses whitespace and clips with an ellipsis', () => {
    expect(oneLine('a  b\n c', 50)).toBe('a b c');
    expect(oneLine('alpha beta gamma delta', 12)).toBe('alpha beta…');
  });
});

describe('previewOf', () => {
  it('is the first item as a sentence, without its owner and due suffix', () => {
    expect(previewOf(['send the quote — Priya (due Wednesday)', 'second'])).toBe('Send the quote');
  });
  it('is empty for no items', () => {
    expect(previewOf([])).toBe('');
  });
});

describe('cardPreview (the Library card line)', () => {
  it('is the writer headline first', () => {
    expect(cardPreview({ summaryLine: 'About the launch.', firstDecision: 'Ship Friday' })).toBe('About the launch.');
  });
  it('is the first decision when there is no headline', () => {
    expect(cardPreview({ summaryLine: null, firstDecision: 'we will ship friday.' })).toBe('Decided: We will ship friday.');
  });
  it('is the first next step when only actions exist', () => {
    expect(cardPreview({ summaryLine: null, firstDecision: null, firstAction: 'send it — Sam' })).toBe('Next: Send it');
  });
  it('is nothing, never a count, when there is nothing', () => {
    expect(cardPreview({ summaryLine: null, firstDecision: null, firstAction: null })).toBeNull();
  });
});
