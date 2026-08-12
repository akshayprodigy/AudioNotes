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

  for (const [name, raw] of Object.entries(PARSE_CASES)) {
    write(name, { input: raw, output: parseMinutesJson(raw) });
  }
  expect(parseMinutesJson(PARSE_CASES.parse_template_echo)).toBeNull();
  expect(parseMinutesJson(PARSE_CASES.parse_broken)).toBeNull();
});
