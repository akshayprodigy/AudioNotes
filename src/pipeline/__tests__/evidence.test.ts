import { extractItems, sentenceSpan, COLLAPSIBLE_WHITESPACE } from '../evidence';
import { extractMinutes, splitSentences } from '../minutes';
import type { Utterance, Speaker } from '../types';

const spk: Speaker[] = [
  { id: 'S0', meetingId: 'm', clusterLabel: '0', displayName: 'Speaker 1', suggestedPerson: null, suggestedName: null },
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

// ---------------------------------------------------------------------------------------------
// Property test: the COLLAPSIBLE_WHITESPACE pre-check never changes the answer.
// ---------------------------------------------------------------------------------------------
//
// findFrom's pre-check exists purely to skip the collapsed-whitespace scan when it can prove the
// literal hit is already the earliest possible match. It is a pure optimisation over a slower,
// obviously-correct implementation that always runs both scans and keeps whichever starts first
// — which means the only thing that makes it safe is that it never, for any input, changes the
// result that slower implementation would have given. The two regression tests above (repeats
// getting distinct spans) pin the SYMPTOM of getting this wrong, not the optimisation itself: a
// future edit that made the pre-check too permissive could pass both of those specific inputs by
// coincidence and still be wrong in general.
//
// So this builds the slower implementation as a reference — findFrom with the pre-check deleted
// — and checks sentenceSpan agrees with it on every (text, sentence, from) triple over a small,
// whitespace-dense alphabet, exhaustively. 'a'/'b' give two interchangeable non-whitespace
// tokens (enough to build sentences that occur more than once); ' ' is the whitespace that never
// collapses away and '\n' is one that always does. Text up to length 5 and sentence up to length
// 3 is the largest that stays comfortably fast (well under a second) — length 6 pushes this past
// a second on this machine, per the reviewer's own note that it's the case-count that doesn't
// matter, not this exact bound.
describe('sentenceSpan property: the pre-check never changes the answer', () => {
  // findFrom, with the pre-check removed: both scans always run, and the candidate that starts
  // first always wins. This is the ground truth sentenceSpan's fast path must never disagree
  // with — deliberately a fork, not a refactor of the real findFrom, because the whole point is
  // to have a second, independently-obviously-correct implementation to compare against.
  function referenceFindFrom(
    text: string,
    sentence: string,
    from: number,
  ): [number, number] | null {
    const direct = text.indexOf(sentence, from);

    const needle = sentence.replace(/\s+/g, ' ');
    const map: number[] = [];
    let flat = '';
    let wasSpace = false;
    for (let i = from; i < text.length; i++) {
      const isSpace = /\s/.test(text[i]);
      if (isSpace) {
        if (!wasSpace && flat.length > 0) {
          map.push(i);
          flat += ' ';
        }
        wasSpace = true;
      } else {
        wasSpace = false;
        map.push(i);
        flat += text[i];
      }
    }
    const at = flat.indexOf(needle);
    const collapsed: [number, number] | null =
      at < 0 ? null : [map[at], map[at + needle.length - 1] + 1];

    if (direct >= 0 && (!collapsed || direct <= collapsed[0])) {
      return [direct, direct + sentence.length];
    }
    return collapsed;
  }

  function referenceSentenceSpan(text: string, sentence: string, from = 0): [number, number] {
    return (
      referenceFindFrom(text, sentence, from) ??
      referenceFindFrom(text, sentence, 0) ?? [0, text.length]
    );
  }

  // Every string over `alphabet` of length 0..maxLen, shortest first.
  function allStrings(alphabet: string[], maxLen: number): string[] {
    let frontier = [''];
    const out = [...frontier];
    for (let len = 1; len <= maxLen; len++) {
      const next: string[] = [];
      for (const s of frontier) for (const c of alphabet) next.push(s + c);
      out.push(...next);
      frontier = next;
    }
    return out;
  }

  it('agrees with a from-scratch reference on every short whitespace-dense triple', () => {
    const ALPHABET = ['a', 'b', ' ', '\n'];
    const texts = allStrings(ALPHABET, 5);
    const sentences = allStrings(ALPHABET, 3).filter(s => s.length > 0);

    // Plain loop with plain comparisons, not a per-case `expect`: at ~600K triples, Jest's
    // matcher machinery would dominate the runtime. One assertion at the end keeps this the
    // "well under a second" property test it needs to be to run on every `npx jest`.
    let cases = 0;
    // findFrom's gate is `direct >= 0 && !COLLAPSIBLE_WHITESPACE.test(...)` — the `&&`
    // short-circuits, so the regex is only ever REACHED when there is a literal hit to weigh in
    // the first place. Most (text, sentence, from) triples in an exhaustive enumeration like this
    // one have no literal hit at all (`from` overshoots every occurrence, or there is none): that
    // is a real thing to test — it exercises the "both scans come up empty" path — but it says
    // nothing about the pre-check, so it must not be allowed to dilute the fraction below. Only
    // triples with a literal hit are candidates for the fraction that matters.
    let candidates = 0;
    let preCheckFires = 0;
    const mismatches: Array<{
      text: string;
      sentence: string;
      from: number;
      got: [number, number];
      want: [number, number];
    }> = [];

    for (const text of texts) {
      for (const sentence of sentences) {
        for (let from = 0; from <= text.length; from++) {
          cases++;

          // Mirrors findFrom's own gate exactly (same regex object, same slice) so this tallies
          // how often the REAL optimisation is actually deciding something, not how often some
          // unrelated whitespace happens to appear in the input.
          const direct = text.indexOf(sentence, from);
          if (direct >= 0) {
            candidates++;
            if (COLLAPSIBLE_WHITESPACE.test(text.slice(from, direct + sentence.length))) {
              preCheckFires++;
            }
          }

          const got = sentenceSpan(text, sentence, from);
          const want = referenceSentenceSpan(text, sentence, from);
          if (got[0] !== want[0] || got[1] !== want[1]) {
            if (mismatches.length < 5) mismatches.push({ text, sentence, from, got, want });
          }
        }
      }
    }

    expect(mismatches).toEqual([]);

    // The real point of this test. If COLLAPSIBLE_WHITESPACE were ever loosened to something
    // that stopped matching real whitespace runs (or the corpus above stopped containing any),
    // the loop above would keep passing — every candidate would just quietly take the fast path
    // — and this test would still read as coverage of the pre-check while checking nothing about
    // it. 20% is a low bar on purpose: measured on this corpus, of the triples where a literal
    // hit exists to weigh at all, the pre-check actually fires on ~57% of them — so anything
    // shrinking that toward zero is the failure this guards against, not noise.
    expect(cases).toBeGreaterThan(0);
    expect(candidates).toBeGreaterThan(0);
    expect(preCheckFires / candidates).toBeGreaterThan(0.2);
  });
});

/**
 * Sentences a meeting actually produces, that the rules used to miss.
 *
 * Both came off the Galaxy A07 on 14 September, word-perfect in the transcript and absent from
 * the minutes. `DECISION` knew "we decided" and "we agreed" but not "we have decided"; and
 * "<Name> will <verb> by <day>" — the most ordinary action sentence there is — was not an action
 * unless the verb happened to be send, get or do, because `<Name> will` only ever labelled an
 * owner and never triggered one. The rules live twice, here and in cpp/minutes/, and the goldens
 * are what keep the two honest; these pin the TypeScript side.
 */
describe('rules: the sentences the A07 meeting said and the minutes missed', () => {
  const turn = (text: string): Utterance => ({
    id: 'u1',
    meetingId: 'm',
    speakerId: 'S0',
    startMs: 0,
    endMs: 1000,
    text,
  });
  const kinds = (text: string) => extractItems([turn(text)], []).map(i => i.kind);

  test('"we have decided that …" is a decision', () => {
    expect(kinds('Agreed, so we have decided that the launch goes ahead on the 1st of October.'))
      .toEqual(['decision']);
  });

  test('"it was decided" and "decided to" are decisions', () => {
    expect(kinds('It was decided to keep the free tier at fifteen minutes.')).toEqual(['decision']);
    expect(kinds('After the demo we decided to drop the lifetime plan.')).toEqual(['decision']);
  });

  test('"<Name> will <verb> by <day>" is an action, owned and dated', () => {
    const [item] = extractItems(
      [turn('Good, Kraya will prepare the play store listing by Friday.')],
      [],
    );
    expect(item.kind).toBe('action');
    expect(item.text).toContain('Kraya');
    expect(item.text).toContain('due by Friday');
  });

  test('"will" on its own is not an action — the verb is what makes one', () => {
    // A forecast and a description, not a commitment. Neither has a verb from the list.
    expect(kinds('It will probably rain during the offsite.')).toEqual([]);
    expect(kinds('The new office will be bigger than this one.')).toEqual([]);
  });
});
