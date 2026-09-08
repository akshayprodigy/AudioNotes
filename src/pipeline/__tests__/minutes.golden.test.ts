// Parity lock between src/pipeline/minutes.ts + summarize.ts and their C++ ports
// (cpp/minutes/). Runs the REAL TS on fixed fixtures and writes golden JSON that the C++
// tests (cpp/tests/) replay byte-for-byte. If you edit minutes.ts or summarize.ts:
//   npx jest minutes.golden   # regenerates goldens
// then re-run the C++ tests and fix the port until they pass again.
import * as fs from 'fs';
import * as path from 'path';
import { extractMinutes } from '../minutes';
import { parseMinutesJson } from '../summarize';
import { extractItems } from '../evidence';
import type { DraftItem } from '../evidence';

const GOLDEN_DIR = path.join(__dirname, '../../../cpp/tests/golden');

const SPEAKERS = [
  { id: 'S0', displayName: 'Speaker 1' },
  { id: 'S1', displayName: 'Speaker 2' },
];

const MEETING = [
  { text: "Alright team, let's kick off the design review. We have three items on the agenda today.", speakerId: 'S0' },
  { text: 'Thanks. First, the rollout plan. I think we should ship version 2.1 this Friday.', speakerId: 'S1' },
  { text: 'Agreed. We decided to go with the phased rollout. Can you also update the project roadmap by Thursday?', speakerId: 'S0' },
  { text: "Sure, I'll update the roadmap by Thursday. Maya will send the summary to everyone tomorrow.", speakerId: 'S1' },
  { text: 'What about the pricing question? Should we revisit it next week?', speakerId: 'S0' },
];

const DEDUP = [
  { text: "I'll send the report by Friday. I'll send the report by Friday.", speakerId: 'S0' },
  { text: "i'll send THE REPORT by friday!", speakerId: 'S1' },
];

const PRIORITY = [
  // question wins over action ("should we" is both QUESTION_WORDS and ACTION_OBLIGATION):
  { text: 'Should we update the roadmap?', speakerId: 'S0' },
  // decision wins over action ("we agreed" + "need to"):
  { text: 'We agreed that we need to ship on Friday.', speakerId: 'S1' },
];

// Rule-level cases inherited from the Kotlin port's test suite (MinutesExtractorTest), moved here
// when MinutesExtractor.kt was deleted in favour of the shared core. Hand-verified against the
// real minutes.ts back then, so they double as an independent check on the C++ port.
const RULES = [
  { text: 'The decision is final: we ship on Monday.', speakerId: 'S0' },
  // "should" is both an ACTION_OBLIGATION trigger and a NAMED_OWNER trigger word, so this one
  // exercises named-owner and due-date detection together. ("Priya will prepare …" would NOT
  // match: "will prepare" is not among the obligation verbs — only will send/get/do are.)
  { text: 'Priya should send the report by next week.', speakerId: 'S1' },
  // Question detected with no question mark, via QUESTION_WORDS + the <160 char rule.
  { text: 'How should we proceed with this rollout.', speakerId: 'S0' },
  // NAMED_OWNER superficially matches "This will", but "This" is on the exclusion list, so the
  // owner must fall through to Unassigned rather than being reported as a person.
  { text: 'This will need to be fixed by Friday.', speakerId: 'S0' },
];

// Decision dedup DOES collapse case/punctuation variants: unlike actions, decision content is
// stored verbatim (no owner appended), so norm() maps both of these to one key.
const DECISION_DEDUP = [
  { text: 'We decided to go with Plan A.', speakerId: 'S0' },
  { text: 'we decided to go with Plan A!', speakerId: 'S0' },
];

// No speaker on any utterance and no speaker rows at all — the shape a single-speaker meeting (or
// one where diarization was skipped) actually produces. Exists mainly to pin the marshalling at
// the JNI boundary, where speakerId becomes "" rather than null.
const UNASSIGNED = [
  { text: 'We decided to ship on Friday.', speakerId: null },
  { text: 'I will send the notes tomorrow.', speakerId: null },
];

const PARSE_CASES: Record<string, string> = {
  parse_valid:
    'Here are the minutes:\n{"summary":"Team reviewed the rollout.","decisions":["Ship 2.1 Friday"],' +
    '"actions":[{"text":"Update roadmap","owner":"Sam","due":"Thursday"}],"questions":["Revisit pricing?"]}\nDone.',
  parse_template_echo:
    '{"summary":"<2-3 sentence overview>","decisions":["..."],"actions":[{"text":"...","owner":"<who>","due":""}],"questions":[]}',
  parse_broken: 'DECISIONS: ship friday. no json here {oops',
  parse_string_actions: '{"summary":"S.","decisions":[],"actions":["Send the deck — Ana"],"questions":[]}',
  parse_na_due: '{"summary":"S.","decisions":[],"actions":[{"text":"Send deck","owner":"Ana","due":"N/A"}],"questions":[]}',
};

test('write golden files for the C++ parity tests', () => {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  const write = (name: string, data: unknown) =>
    fs.writeFileSync(path.join(GOLDEN_DIR, `${name}.json`), JSON.stringify(data, null, 1) + '\n');

  const meeting = extractMinutes(MEETING as any, SPEAKERS as any);
  write('minutes_meeting', { input: { utterances: MEETING, speakers: SPEAKERS }, output: meeting });
  expect(meeting.length).toBeGreaterThan(3);
  // The summary row is the free tier's overview and the top of every export, so the goldens pin
  // its composition too: what was decided, then who owes what, and only then the tally. A port
  // that still emits the bare count row fails here rather than shipping a different document to
  // the people whose minutes native writes.
  expect(meeting[0].kind).toBe('summary');
  expect(meeting[0].content).toBe(
    'Decided: We decided to go with the phased rollout. ' +
      "Next: Alright team, let's kick off the design review. — Speaker 1; " +
      "Sure, I'll update the roadmap by Thursday. — Speaker 2 (due by Thursday); " +
      'Maya will send the summary to everyone tomorrow. — Maya (due tomorrow). ' +
      '4 action items, 1 decision, 3 open questions.',
  );

  const dedup = extractMinutes(DEDUP as any, SPEAKERS as any);
  write('minutes_dedup', { input: { utterances: DEDUP, speakers: SPEAKERS }, output: dedup });
  // Dedup keys on the COMPOSED content (owner appended), so S0's repeated sentence collapses to
  // one action but S1's identical wording survives as its own (different owner): 3 sentences -> 2.
  expect(dedup.filter(m => m.kind === 'action').length).toBe(2);

  const priority = extractMinutes(PRIORITY as any, SPEAKERS as any);
  write('minutes_priority', { input: { utterances: PRIORITY, speakers: SPEAKERS }, output: priority });
  expect(priority.filter(m => m.kind === 'action').length).toBe(0); // both classified away from action

  const rules = extractMinutes(RULES as any, SPEAKERS as any);
  write('minutes_rules', { input: { utterances: RULES, speakers: SPEAKERS }, output: rules });
  const content = rules.map(m => m.content);
  expect(content).toContain('The decision is final: we ship on Monday.');
  expect(content).toContain('Priya should send the report by next week. — Priya (due next week)');
  expect(content).toContain('How should we proceed with this rollout.');
  expect(content).toContain('This will need to be fixed by Friday. — Unassigned (due by Friday)');

  const decisionDedup = extractMinutes(DECISION_DEDUP as any, SPEAKERS as any);
  write('minutes_decision_dedup', {
    input: { utterances: DECISION_DEDUP, speakers: SPEAKERS },
    output: decisionDedup,
  });
  const decisions = decisionDedup.filter(m => m.kind === 'decision');
  expect(decisions.length).toBe(1);
  expect(decisions[0].content).toBe('We decided to go with Plan A.'); // first occurrence wins

  const unassigned = extractMinutes(UNASSIGNED as any, [] as any);
  write('minutes_unassigned', { input: { utterances: UNASSIGNED, speakers: [] }, output: unassigned });
  // With no speaker name to attribute to, first-person actions fall through to Unassigned.
  expect(unassigned.map(m => m.kind)).toEqual(['summary', 'decision', 'action']);

  const empty = extractMinutes([] as any, [] as any);
  write('minutes_empty', { input: { utterances: [], speakers: [] }, output: empty });
  expect(empty.length).toBe(1);
  expect(empty[0].kind).toBe('summary');
  // Nothing to lead with, so the overview is exactly the tally sentence it always was — the one
  // case where the composed summary and the old count row are byte-identical.
  expect(empty[0].content).toBe('0 action items, 0 decisions, 0 open questions.');

  for (const [name, raw] of Object.entries(PARSE_CASES)) {
    write(name, { input: raw, output: parseMinutesJson(raw) });
  }
  expect(parseMinutesJson(PARSE_CASES.parse_template_echo)).toBeNull();
  expect(parseMinutesJson(PARSE_CASES.parse_broken)).toBeNull();
});

// Timed variants of the existing fixtures. The rule fixtures carry no timings because
// extractMinutes never needed any; extractItems does, so most turns get four seconds. Turn
// index 2 runs long instead (6500ms) - every other turn stays uniform and contiguous, so a port
// that assumed endMs = startMs + 4000, or passed through source ms with no merge logic, would
// have nothing here to fail against.
function timed(rows: { text: string; speakerId: string | null }[]) {
  let cursorMs = 0;
  return rows.map((r, i) => {
    const startMs = cursorMs;
    const durationMs = i === 2 ? 6500 : 4000;
    cursorMs += durationMs;
    return {
      id: `u${i}`,
      meetingId: 'm',
      startMs,
      endMs: cursorMs,
      speakerId: r.speakerId,
      text: r.text,
    };
  });
}

const SPANS = [
  // The whitespace runs are INSIDE the sentences, not between them. A run between two sentences
  // is not in either of them, so text.indexOf still finds each one intact and the fallback is
  // never entered - which is exactly the mistake the first version of this fixture made.
  { text: 'Good morning. We agreed  to ship on\nMonday.', speakerId: 'S0' },
  // The same sentence twice in ONE turn: each source must carry its OWN span, not the first
  // occurrence's. This is whisper's repetition-loop failure mode, which this project has on
  // record from the Galaxy A07.
  { text: "Right. I'll send the report by Friday. I'll send the report by Friday.", speakerId: 'S1' },
  // The ordering case, and the one no ordinary fixture shows: the FIRST copy carries the internal
  // run, so a naive text.indexOf returns the SECOND copy and both sources end up sharing its span.
  // Any port that tries the direct match before the collapsed one fails on exactly this row.
  { text: 'We agreed  to ship. We agreed to ship.', speakerId: 'S0' },
  // Non-ASCII BEFORE the span, so byte offsets, code-point offsets and UTF-16 offsets are three
  // different numbers. Curly quotes and an astral emoji: the emoji is the only thing separating
  // UTF-16 units from code points, which is the mistake a UTF-8-decoding port makes and no
  // amount of em dashes would catch. A non-breaking space inside the sentence exercises the
  // other half - JS \s matches U+00A0 and a byte-wise C++ isspace does not, which corrupts the
  // item TEXT and not just its span. The span still needs the collapsed scan, so the conversion
  // is exercised on a byte offset that came out of the flatten map.
  {
    text: 'Priya said “ship it” \u{1F680}. We agreed   to ship on\nMonday.',
    speakerId: 'S1',
  },
];

// Pins the caps (20 decisions / 30 actions / 20 questions) the same way evidence.test.ts's
// "matches extractMinutes even when every bucket is over its cap" test does, but as a golden the
// C++ port has to replay: every bucket here is well past its cap (25/35/25).
function capBusting(): { text: string; speakerId: string }[] {
  const rows: { text: string; speakerId: string }[] = [];
  for (let i = 0; i < 25; i++) rows.push({ text: `We decided to ship batch ${i}.`, speakerId: 'S0' });
  for (let i = 0; i < 35; i++) rows.push({ text: `I'll send report ${i}.`, speakerId: 'S1' });
  for (let i = 0; i < 25; i++) rows.push({ text: `Should we revisit topic ${i}?`, speakerId: 'S0' });
  return rows;
}

function writeEvidenceGolden(
  name: string,
  rows: { text: string; speakerId: string | null }[],
): DraftItem[] {
  const utterances = timed(rows);
  const speakers = SPEAKERS.map(s => ({ ...s, meetingId: 'm', clusterLabel: s.id }));
  const output = extractItems(utterances as any, speakers as any);
  fs.writeFileSync(
    path.join(GOLDEN_DIR, name),
    JSON.stringify({ input: { utterances, speakers }, output }, null, 2) + '\n',
  );
  return output;
}

it('writes the evidence goldens', () => {
  const meeting = writeEvidenceGolden('evidence_meeting.json', MEETING);
  expect(fs.existsSync(path.join(GOLDEN_DIR, 'evidence_meeting.json'))).toBe(true);
  expect(meeting.length).toBeGreaterThan(0);

  const dedup = writeEvidenceGolden('evidence_dedup.json', DEDUP);
  expect(dedup.filter(i => i.kind === 'action').length).toBe(2);

  const spans = writeEvidenceGolden('evidence_spans.json', SPANS);
  const decisions = spans.filter(i => i.kind === 'decision');
  const action = spans.find(i => i.kind === 'action')!;

  // Row 2: two repeats within one turn get two distinct spans - equal charStart values would
  // mean both sources point at the same occurrence.
  expect(new Set(action.sources.map(s => s.charStart)).size).toBe(2);

  // Row 3: the FIRST copy carries the whitespace run, so the earliest match must win. A
  // charStart of 20 for the FIRST source would mean the direct match beat the collapsed one -
  // the exact bug this row exists to catch.
  const ordering = decisions.find(d => d.text === 'We agreed to ship.')!;
  expect(ordering.sources.map(s => s.charStart)).toEqual([0, 20]);

  // Rows 1 and 4 share the collapsed sentence "We agreed to ship on Monday." (row 4 only adds a
  // new prefix; its suffix deliberately matches row 1's), so they land in ONE decision item with
  // two sources - an incidental second exercise of the cross-turn merge Critical 2 covers.
  const onMonday = decisions.find(d => d.text === 'We agreed to ship on Monday.')!;
  expect(onMonday.sources).toHaveLength(2);
  const [row1Source, row4Source] = onMonday.sources;

  // Row 1: the collapsed scan ran - the slice recovered from the ORIGINAL text still holds the
  // double space and the newline that a literal indexOf could never have matched.
  expect(row1Source.utteranceId).toBe('u0');
  expect(SPANS[0].text.slice(row1Source.charStart, row1Source.charEnd)).toBe(
    'We agreed  to ship on\nMonday.',
  );

  // Row 4: the only thing separating three different offset interpretations (bytes, code
  // points, UTF-16 units) is what precedes the span - curly quotes (3 bytes / 1 unit each in
  // UTF-8) and an astral emoji (4 bytes / 2 units / 1 code point). If any two of the three
  // interpretations coincided here, a port using the wrong one could still pass.
  expect(row4Source.utteranceId).toBe('u3');
  const turn4 = SPANS[3].text;
  const utf16Start = row4Source.charStart;
  const byteStart = Buffer.byteLength(turn4.slice(0, utf16Start), 'utf8');
  const codePointStart = Array.from(turn4.slice(0, utf16Start)).length;
  expect(new Set([utf16Start, byteStart, codePointStart]).size).toBe(3);
  // ...and the slice itself must reproduce the real sentence, non-breaking space included - the
  // one detail a UTF-16-to-original conversion done on top of the collapsed scan has to survive.
  expect(turn4.slice(row4Source.charStart, row4Source.charEnd)).toBe(
    'We agreed   to ship on\nMonday.',
  );

  const decisionDedup = writeEvidenceGolden('evidence_decision_dedup.json', DECISION_DEDUP);
  const dedupDecision = decisionDedup.find(i => i.kind === 'decision')!;
  // First-wins gives (0, 4000), last-wins gives (4000, 8000) - only min/max over BOTH sources
  // gives the full envelope DraftItem's own doc comment describes.
  expect(dedupDecision.sources.map(s => s.utteranceId)).toEqual(['u0', 'u1']);
  expect(dedupDecision.anchorStartMs).toBe(0);
  expect(dedupDecision.anchorEndMs).toBe(8000);

  const priority = writeEvidenceGolden('evidence_priority.json', PRIORITY);
  expect(priority.filter(i => i.kind === 'action').length).toBe(0); // both classified away from action

  const unassigned = writeEvidenceGolden('evidence_unassigned.json', UNASSIGNED);
  expect(unassigned.map(i => i.kind)).toEqual(['decision', 'action']);

  const empty = writeEvidenceGolden('evidence_empty.json', []);
  expect(empty).toEqual([]);

  const caps = writeEvidenceGolden('evidence_caps.json', capBusting());
  expect(caps.filter(i => i.kind === 'decision').length).toBe(20);
  expect(caps.filter(i => i.kind === 'action').length).toBe(30);
  expect(caps.filter(i => i.kind === 'question').length).toBe(20);
});
