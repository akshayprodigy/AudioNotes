import { extractItems } from '../evidence';
import type { Utterance, Speaker } from '../types';

const spk: Speaker[] = [
  { id: 'S0', meetingId: 'm', clusterLabel: '0', displayName: 'Speaker 1' },
];

function utt(id: string, startMs: number, endMs: number, text: string): Utterance {
  return { id, meetingId: 'm', startMs, endMs, speakerId: 'S0', text };
}

describe('extractItems', () => {
  it('anchors an item to the utterance it was lifted from', () => {
    const items = extractItems([utt('u1', 5000, 9000, "I'll send the report by Friday.")], spk);
    const action = items.find(i => i.kind === 'action')!;
    expect(action.sources).toHaveLength(1);
    expect(action.sources[0]).toMatchObject({
      utteranceId: 'u1',
      startMs: 5000,
      endMs: 9000,
    });
    expect(action.anchorStartMs).toBe(5000);
    expect(action.anchorEndMs).toBe(9000);
  });

  it('records the character span of the sentence inside its turn', () => {
    const text = 'Good morning everyone. We agreed to ship on Monday.';
    const items = extractItems([utt('u1', 0, 4000, text)], spk);
    const decision = items.find(i => i.kind === 'decision')!;
    const { charStart, charEnd } = decision.sources[0];
    expect(text.slice(charStart, charEnd)).toBe('We agreed to ship on Monday.');
  });

  it('keeps every source when the same item is said twice', () => {
    const items = extractItems(
      [
        utt('u1', 1000, 3000, "I'll send the report by Friday."),
        utt('u2', 8000, 9500, "I'll send the report by Friday."),
      ],
      spk,
    );
    const action = items.find(i => i.kind === 'action')!;
    expect(action.sources.map(s => s.utteranceId)).toEqual(['u1', 'u2']);
    expect(action.anchorStartMs).toBe(1000);
    expect(action.anchorEndMs).toBe(9500);
  });

  it('produces the same texts, in the same order, as extractMinutes', () => {
    const utts = [
      utt('u1', 0, 2000, 'We agreed to ship on Monday.'),
      utt('u2', 2000, 4000, "I'll send the report by Friday."),
      utt('u3', 4000, 6000, 'Should we revisit pricing?'),
    ];
    const { extractMinutes } = require('../minutes');
    const fromMinutes = extractMinutes(utts, spk)
      .filter((m: any) => m.kind !== 'summary')
      .map((m: any) => `${m.kind}|${m.content}`);
    const fromItems = extractItems(utts, spk).map(i => `${i.kind}|${i.text}`);
    expect(fromItems).toEqual(fromMinutes);
  });
});
