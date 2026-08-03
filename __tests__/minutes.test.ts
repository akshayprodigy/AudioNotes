import { extractMinutes } from '../src/pipeline/minutes';
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
  { id: 's1', meetingId: 'm', clusterLabel: 'A', displayName: 'Akshay' },
  { id: 's2', meetingId: 'm', clusterLabel: 'B', displayName: 'Priya' },
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
