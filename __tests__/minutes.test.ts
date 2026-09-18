import { composeSummary, extractMinutes } from '../src/pipeline/minutes';
import type { Utterance, Speaker } from '../src/pipeline/types';

const utt = (id: string, speakerId: string, text: string): Utterance => ({
  id,
  meetingId: 'm',
  startMs: 0,
  endMs: 0,
  speakerId,
  text,
});

const speakers: Speaker[] = [
  { id: 's1', meetingId: 'm', clusterLabel: 'A', displayName: 'Akshay', suggestedPerson: null, suggestedName: null },
  { id: 's2', meetingId: 'm', clusterLabel: 'B', displayName: 'Priya', suggestedPerson: null, suggestedName: null },
];

const transcript: Utterance[] = [
  utt('1', 's1', "Okay so the main thing is the Android MVP. I'll finish the VAD integration by Friday."),
  utt('2', 's2', 'Can you send me the build config today? Also, what about the iOS timeline?'),
  utt('3', 's1', 'We decided to go with React Native for the UI layer.'),
  utt('4', 's2', 'Priya will prepare the demo script by next week.'),
  utt('5', 's1', 'We need to test on a real mid-range device. Should we buy a Snapdragon 6-series phone?'),
  utt('6', 's2', "Let's finalize the pricing after the alpha."),
  utt('7', 's1', 'Nothing much else, just casual chat about the weather.'),
  utt('8', 's1', "I'll finish the VAD integration by Friday."), // duplicate -> deduped
];

describe('extractMinutes (rule-based floor)', () => {
  const mins = extractMinutes(transcript, speakers);
  const byKind = (k: string) => mins.filter(m => m.kind === k);

  it('leads with a factual overview summary', () => {
    expect(mins[0].kind).toBe('summary');
  });

  it('captures the explicit decision', () => {
    const decisions = byKind('decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].content).toMatch(/React Native/);
  });

  it('attributes first-person actions to the speaker', () => {
    expect(byKind('action').some(a => /Akshay/.test(a.content))).toBe(true);
  });

  it('detects a named owner', () => {
    expect(byKind('action').some(a => /Priya/.test(a.content))).toBe(true);
  });

  it('detects a due date', () => {
    expect(byKind('action').some(a => /due by Friday/i.test(a.content))).toBe(true);
  });

  it('captures open questions', () => {
    expect(byKind('question').length).toBeGreaterThanOrEqual(2);
  });

  it('deduplicates repeated action items', () => {
    const actions = byKind('action').map(a => a.content);
    expect(new Set(actions).size).toBe(actions.length);
  });
});

// The overview line is the free tier's summary: the first thing in an exported Markdown file and
// the document a free user forwards to a colleague. It used to be the tally alone ("12 action
// items, 3 decisions, 5 open questions"), which says nothing about the meeting. composeSummary is
// kept word-for-word identical to the Kotlin renderer (FileExportModule.kt) and the C++ core
// (cpp/minutes/minutes_extractor.cpp), so these expectations double as the spec those ports meet.
describe('composeSummary (the free tier’s overview line)', () => {
  it('leads with the decisions, then the actions, and keeps the tally last', () => {
    const s = composeSummary(
      ['We decided to go with the phased rollout.'],
      ['Send the deck — Priya (due Friday)'],
      ['Should we revisit pricing?'],
    );
    expect(s).toBe(
      'Decided: We decided to go with the phased rollout. ' +
        'Next: Send the deck — Priya (due Friday). ' +
        '1 action item, 1 decision, 1 open question.',
    );
    // The old behaviour is what must NOT survive: a count where the meeting should be.
    expect(s.startsWith('1 action item')).toBe(false);
  });

  it('quotes actions that have an owner ahead of ones nobody has taken', () => {
    const s = composeSummary(
      [],
      [
        'Fix the build — Unassigned',
        'Fix the build again — Unassigned',
        'Fix the build once more — Unassigned',
        'Send the report — Priya (due next week)',
      ],
    []);
    // Four actions, three quoted: the named owner must displace one of the unassigned ones rather
    // than being cut off the end because it was spoken last.
    expect(s).toContain('Next: Send the report — Priya (due next week);');
    expect(s).toContain('4 action items, 0 decisions, 0 open questions.');
  });

  it('quotes at most two decisions and three actions, leaving the rest to the tally', () => {
    const s = composeSummary(
      ['D one.', 'D two.', 'D three.'],
      ['A one — Ana', 'A two — Ana', 'A three — Ana', 'A four — Ana'],
      [],
    );
    expect(s).toContain('Decided: D one; D two.');
    expect(s).not.toContain('D three');
    expect(s).toContain('Next: A one — Ana; A two — Ana; A three — Ana.');
    expect(s).not.toContain('A four');
    expect(s).toContain('4 action items, 3 decisions, 0 open questions.');
  });

  it('clips a long spoken sentence on a word boundary instead of mid-word', () => {
    const long = 'We need to ' + 'reconcile the vendor invoices '.repeat(12) + 'before Friday.';
    const s = composeSummary([], [long + ' — Ana'], []);
    const quoted = s.slice('Next: '.length, s.indexOf('. 1 action item'));
    expect(quoted.endsWith('…')).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(161);
    // The kept text must be a whole-word prefix of what was said — the character that follows it
    // in the original is a space, so the reader never sees a word sliced down the middle.
    const kept = quoted.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long.charAt(kept.length)).toBe(' ');
  });

  it('falls back to exactly the old tally sentence when there is nothing to lead with', () => {
    // A meeting of nothing but questions has no decision and no owed work. Saying so plainly is
    // honest, and it keeps the empty case byte-identical to what the goldens held before.
    expect(composeSummary([], [], ['What is the budget?'])).toBe(
      '0 action items, 0 decisions, 1 open question.',
    );
    expect(composeSummary([], [], [])).toBe('0 action items, 0 decisions, 0 open questions.');
  });

  it('is what extractMinutes writes into the summary row', () => {
    const mins = extractMinutes(transcript, speakers);
    const summary = mins.find(m => m.kind === 'summary')!;
    expect(summary.content).toMatch(/^Decided: /);
    expect(summary.content).toMatch(/Next: /);
    expect(summary.content).toMatch(/\d+ action items?, \d+ decisions?, \d+ open questions?\.$/);
  });
});
