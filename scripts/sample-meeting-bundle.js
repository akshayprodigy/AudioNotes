#!/usr/bin/env node
// Stage 4 of scripts/make-sample-meeting.sh: turns the pipeline's run document and the script's
// line table into src/sample/sampleMeeting.json. Read the header of that script first.
//
//   node scripts/sample-meeting-bundle.js <run.json> <lines.json> <out.json>
//
// What comes from where:
//   - TIMES: the real pipeline's utterances (VAD + whisper over the shipped audio). Each script
//     line takes the span of the pipeline utterances that fall inside it.
//   - WORDS: the script (a price said in words is written as the pipeline wrote it, "$4,500"). whisper-base on synthetic voices writes "Hellbent articles" for "help
//     articles", and a demo that opens on a mishearing teaches the wrong lesson about the app.
//     The words are therefore what the voices were given to say, and the sample is labelled as a
//     sample everywhere it appears.
//   - SPEAKERS: the script ("Priya", "Sam"), because two synthetic voices diarize as one speaker.
//   - ITEMS, OWNERS, DUE DATES, ANCHORS, SUMMARY: the app's own rule extractor
//     (src/pipeline/evidence.ts and minutes.ts), run over exactly the utterances above. Nothing
//     here is typed by hand, so the sample shows what the Free path really writes.
//
// The only judgement calls are the two constants below.
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

// Load the app's own TypeScript without a build step: transpile on require, extensionless
// imports resolve through the registered extension.
require.extensions['.ts'] = (module, filename) => {
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  module._compile(out, filename);
};
const root = path.join(__dirname, '..');
const { extractItems } = require(path.join(root, 'src/pipeline/evidence.ts'));
const { extractMinutes } = require(path.join(root, 'src/pipeline/minutes.ts'));

const MEETING_ID = 'sample-meeting-v1';
/** The item shown already ticked off, so the sample demonstrates a finished action too. */
const DONE_ITEM = /launch checklist/i;
const TITLE = 'Weekly check-in (sample)';
/**
 * How the transcript writes what the voices say aloud. The pipeline's own rendering of the price
 * line was "$4,500" (see the run document), so that is what the transcript shows; the voice still
 * says it in words.
 */
const WRITTEN = [[/four thousand five hundred dollars/g, '$4,500']];

const [runPath, linesPath, outPath] = process.argv.slice(2);
if (!runPath || !linesPath || !outPath) {
  console.error('usage: sample-meeting-bundle.js <run.json> <lines.json> <out.json>');
  process.exit(2);
}
const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
const lines = JSON.parse(fs.readFileSync(linesPath, 'utf8'));

// Which line each pipeline utterance belongs to: the one that contains its midpoint, with a
// little slack for the encoder's delay.
const SLACK = 250;
const spans = lines.map(() => ({ start: Infinity, end: -Infinity }));
for (const u of run.transcript) {
  const mid = (u.start_ms + u.end_ms) / 2;
  const at = lines.findIndex(l => mid >= l.startMs - SLACK && mid <= l.endMs + SLACK);
  if (at < 0) throw new Error(`pipeline utterance at ${u.start_ms} ms falls in no script line`);
  spans[at].start = Math.min(spans[at].start, u.start_ms);
  spans[at].end = Math.max(spans[at].end, u.end_ms);
}
spans.forEach((s, i) => {
  if (!Number.isFinite(s.start)) throw new Error(`script line ${i + 1} has no pipeline utterance`);
});

const speakerNames = [...new Set(lines.map(l => l.speaker))];
const speakers = speakerNames.map((name, i) => ({
  id: `${MEETING_ID}:spk:${i + 1}`,
  clusterLabel: `S${i}`,
  displayName: name,
}));
const speakerByName = new Map(speakers.map(s => [s.displayName, s]));

const utterances = lines.map((l, i) => ({
  id: `${MEETING_ID}:u:${i + 1}`,
  meetingId: MEETING_ID,
  startMs: spans[i].start,
  endMs: spans[i].end,
  speakerId: speakerByName.get(l.speaker).id,
  text: WRITTEN.reduce((t, [spoken, written]) => t.replace(spoken, written), l.text),
}));

const minutes = extractMinutes(utterances, speakers);
const drafts = extractItems(utterances, speakers);
const uttIndex = new Map(utterances.map((u, i) => [u.id, i + 1]));

const items = drafts.map((d, n) => {
  const first = d.sources[0];
  const speaker = speakers.find(s => s.id === utterances[uttIndex.get(first.utteranceId) - 1].speakerId);
  // The rule pass records WHICH SPEAKER owns an action when the owner it found is the person who
  // said "I will": the name in the text then follows a later rename. Anything else (unassigned,
  // or another person's name) stays plain text.
  const owner = / — ([^()]+?)(?: \(due [^)]*\))?$/.exec(d.text);
  const ownerJson =
    owner && d.kind === 'action' && owner[1] === speaker.displayName
      ? JSON.stringify({ kind: 'speaker', id: speaker.id })
      : null;
  return {
    id: `${MEETING_ID}:item:${n + 1}`,
    kind: d.kind,
    text: d.text,
    ownerJson,
    anchorStartMs: d.anchorStartMs,
    anchorEndMs: d.anchorEndMs,
    done: d.kind === 'action' && DONE_ITEM.test(d.text),
    sources: d.sources.map(s => ({
      startMs: s.startMs,
      endMs: s.endMs,
      charStart: s.charStart,
      charEnd: s.charEnd,
      utteranceId: s.utteranceId,
    })),
  };
});

const bundle = {
  id: MEETING_ID,
  title: TITLE,
  durationMs: run.audio_ms,
  language: 'en',
  speakers,
  utterances: utterances.map(({ meetingId, ...u }) => u),
  minutes: minutes.map(m => ({ kind: m.kind, content: m.content })),
  items,
};
fs.writeFileSync(outPath, JSON.stringify(bundle, null, 1) + '\n');
console.log(`${outPath}: ${utterances.length} utterances, ${items.length} items`);
