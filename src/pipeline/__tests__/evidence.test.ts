import { extractItems, sentenceSpan } from '../evidence';
import { extractMinutes, splitSentences } from '../minutes';
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

  // A repeated sentence inside ONE turn is whisper's repetition-loop failure mode — on record
  // from the Galaxy A07 field test (43 invented words from room tone). Without a search cursor,
  // sentenceSpan would find the FIRST occurrence for every repeat, so two sources would both
  // point at the same six words instead of the two separate places they actually sit.
  it('gives repeated sentences within one turn distinct spans', () => {
    const text = 'We agreed to ship. We agreed to ship.';
    const items = extractItems([utt('u1', 0, 5000, text)], spk);
    const decision = items.find(i => i.kind === 'decision')!;
    expect(decision.sources).toHaveLength(2);
    expect(decision.sources[0]).toMatchObject({ utteranceId: 'u1', charStart: 0, charEnd: 18 });
    expect(decision.sources[1]).toMatchObject({ utteranceId: 'u1', charStart: 19, charEnd: 37 });
    expect(text.slice(0, 18)).toBe('We agreed to ship.');
    expect(text.slice(19, 37)).toBe('We agreed to ship.');
  });

  // The previous fix (a search cursor) is not enough on its own: text.indexOf(sentence, from) is
  // not guaranteed to find the EARLIEST occurrence at-or-after `from`. A copy of the sentence
  // carrying an internal whitespace run (a doubled space here) sits before the literal copy, and
  // only the whitespace-collapsing scan can see it — indexOf walks straight past it to the later,
  // literal one. Two sources still ended up pointing at the same span until this was fixed too.
  it('anchors each repeat separately when one copy has an internal whitespace run', () => {
    const text = 'We agreed  to ship. We agreed to ship.';
    const items = extractItems([utt('u1', 0, 5000, text)], spk);
    const decision = items.find(i => i.kind === 'decision')!;
    expect(decision.sources.map(s => [s.charStart, s.charEnd])).toEqual([
      [0, 19],
      [20, 38],
    ]);
  });

  // Three repeats, whitespace run in the MIDDLE one — the shape that most directly breaks a
  // fix which only compares the direct hit against the cursor: the middle occurrence sits between
  // two literal ones, so a naive earliest-vs-cursor comparison can walk past it entirely and never
  // anchor it at all.
  it('anchors three repeats separately when the middle one has a line break inside it', () => {
    const text = 'We agreed to ship. We agreed\nto ship. We agreed to ship.';
    const items = extractItems([utt('u1', 0, 5000, text)], spk);
    const decision = items.find(i => i.kind === 'decision')!;
    expect(decision.sources.map(s => [s.charStart, s.charEnd])).toEqual([
      [0, 18],
      [19, 37],
      [38, 56],
    ]);
  });

  it('produces the same texts, in the same order, as extractMinutes', () => {
    const utts = [
      utt('u1', 0, 2000, 'We agreed to ship on Monday.'),
      utt('u2', 2000, 4000, "I'll send the report by Friday."),
      utt('u3', 4000, 6000, 'Should we revisit pricing?'),
    ];
    const fromMinutes = extractMinutes(utts, spk)
      .filter(m => m.kind !== 'summary')
      .map(m => `${m.kind}|${m.content}`);
    const fromItems = extractItems(utts, spk).map(i => `${i.kind}|${i.text}`);
    expect(fromItems).toEqual(fromMinutes);
  });

  // The four-test parity check above uses one utterance per bucket, so it never exercises the
  // slice(0, N) caps, dedup, or a turn with more than one sentence. This is the test the comment
  // in evidence.ts actually points to: it pushes every bucket well past its cap (25 decisions,
  // 35 actions, 25 questions against caps of 20/30/20) and checks extractItems still matches
  // extractMinutes texts and order, then checks the caps actually bit.
  it('matches extractMinutes even when every bucket is over its cap', () => {
    const utts: Utterance[] = [];
    let t = 0;
    for (let i = 0; i < 25; i++) {
      utts.push(utt(`d${i}`, t, t + 900, `We decided to ship batch ${i}.`));
      t += 1000;
    }
    for (let i = 0; i < 35; i++) {
      utts.push(utt(`a${i}`, t, t + 900, `I'll send report ${i}.`));
      t += 1000;
    }
    for (let i = 0; i < 25; i++) {
      utts.push(utt(`q${i}`, t, t + 900, `Should we revisit topic ${i}?`));
      t += 1000;
    }

    const fromMinutes = extractMinutes(utts, spk)
      .filter(m => m.kind !== 'summary')
      .map(m => `${m.kind}|${m.content}`);
    const fromItems = extractItems(utts, spk).map(i => `${i.kind}|${i.text}`);
    expect(fromItems).toEqual(fromMinutes);

    expect(fromItems.filter(s => s.startsWith('decision|'))).toHaveLength(20);
    expect(fromItems.filter(s => s.startsWith('action|'))).toHaveLength(30);
    expect(fromItems.filter(s => s.startsWith('question|'))).toHaveLength(20);
  });
});

describe('sentenceSpan', () => {
  it('finds a sentence whose whitespace splitSentences collapsed', () => {
    const t = 'Good morning. We agreed  to ship on\nMonday.';
    const s = splitSentences(t)[1]; // 'We agreed to ship on Monday.'
    const [a, b] = sentenceSpan(t, s);
    expect(t.slice(a, b)).toBe('We agreed  to ship on\nMonday.');
  });

  it('returns the whole turn rather than nothing when it cannot find the sentence', () => {
    expect(sentenceSpan('hello world', 'goodbye')).toEqual([0, 11]);
  });

  // The cursor is a lower bound, not a hard boundary. If it has overshot — the previous
  // sentence's span came from the fallback path and landed slightly wide, say — a search that
  // fails from the cursor must retry from 0 rather than silently handing back a whole-turn span
  // for a sentence that is actually right there.
  it('retries from the start when the cursor has overshot the sentence', () => {
    const text = 'We agreed to ship. We agreed to ship.';
    const [a, b] = sentenceSpan(text, 'We agreed to ship.', 30);
    expect(text.slice(a, b)).toBe('We agreed to ship.');
  });
});
