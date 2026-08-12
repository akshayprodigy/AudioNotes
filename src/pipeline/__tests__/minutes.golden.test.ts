// Parity lock between src/pipeline/minutes.ts + summarize.ts and their C++ ports
// (cpp/minutes/). Runs the REAL TS on fixed fixtures and writes golden JSON that the C++
// tests (cpp/tests/) replay byte-for-byte. If you edit minutes.ts or summarize.ts:
//   npx jest minutes.golden   # regenerates goldens
// then re-run the C++ tests and fix the port until they pass again.
import * as fs from 'fs';
import * as path from 'path';
import { extractMinutes } from '../minutes';
import { parseMinutesJson } from '../summarize';

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

  for (const [name, raw] of Object.entries(PARSE_CASES)) {
    write(name, { input: raw, output: parseMinutesJson(raw) });
  }
  expect(parseMinutesJson(PARSE_CASES.parse_template_echo)).toBeNull();
  expect(parseMinutesJson(PARSE_CASES.parse_broken)).toBeNull();
});
