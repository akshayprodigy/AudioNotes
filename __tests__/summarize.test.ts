import {
  chunkTranscript,
  transcriptLines,
  parseMinutesJson,
  enhanceMinutes,
} from '../src/pipeline/summarize';
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
];

describe('summarize helpers', () => {
  it('renders transcript lines with speaker names', () => {
    const lines = transcriptLines([utt('1', 's1', 'hello')], speakers);
    expect(lines[0]).toBe('Akshay: hello');
  });

  it('chunks long transcripts and keeps short ones single', () => {
    expect(chunkTranscript(['a', 'b'], 100)).toHaveLength(1);
    const big = Array.from({ length: 50 }, (_, i) => 'x'.repeat(200) + i);
    expect(chunkTranscript(big, 1000).length).toBeGreaterThan(1);
  });

  it('parses a clean JSON minutes object', () => {
    const raw =
      'Sure! {"summary":"We aligned on the MVP.","decisions":["Use React Native"],' +
      '"actions":[{"text":"Ship the alpha","owner":"Akshay","due":"Friday"}],' +
      '"questions":["Which device to test on?"]}';
    const mins = parseMinutesJson(raw)!;
    expect(mins[0]).toEqual({ kind: 'summary', content: 'We aligned on the MVP.', source: 'llm' });
    expect(mins.some(m => m.kind === 'decision' && /React Native/.test(m.content))).toBe(true);
    expect(mins.some(m => m.kind === 'action' && /Akshay/.test(m.content) && /due Friday/.test(m.content))).toBe(true);
    expect(mins.some(m => m.kind === 'question')).toBe(true);
  });

  it('returns null on unparseable output (caller keeps the rule-based floor)', () => {
    expect(parseMinutesJson('the model rambled with no json')).toBeNull();
  });

  // A 1.5B model shipped the prompt's own skeleton back verbatim and it became three minutes
  // reading "…". Nothing survives the filter here, so the caller falls back to the rule-based set.
  it('drops template placeholders the model echoed back', () => {
    const echoed =
      '{"summary":"...","decisions":["..."],' +
      '"actions":[{"text":"...","owner":"...","due":"..."}],"questions":["..."]}';
    expect(parseMinutesJson(echoed)).toBeNull();
  });

  it('drops angle-bracket descriptors but keeps real text beside them', () => {
    const mins = parseMinutesJson(
      '{"summary":"<2-3 sentence overview>","decisions":["Ship on <Friday>"]}',
    )!;
    expect(mins).toHaveLength(1);
    expect(mins[0]).toEqual({ kind: 'decision', content: 'Ship on <Friday>', source: 'llm' });
  });

  it('drops n/a due dates', () => {
    const mins = parseMinutesJson('{"actions":[{"text":"do it","owner":"Team","due":"N/A"}]}')!;
    expect(mins[0].content).toBe('do it — Team');
  });

  it('enhanceMinutes single-pass calls reduce and parses', async () => {
    const fakeGenerate = async () =>
      '{"summary":"Short sync.","decisions":[],"actions":[],"questions":["Next steps?"]}';
    const mins = await enhanceMinutes([utt('1', 's1', 'quick chat')], speakers, fakeGenerate);
    expect(mins).not.toBeNull();
    expect(mins![0].kind).toBe('summary');
  });
});
