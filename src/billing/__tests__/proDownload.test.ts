import { proToFetch } from '../proDownload';

const row = (id: string, sizeBytes: number, o: Partial<{ installed: boolean; needsSubscription: boolean; unsupportedReason: string | null; kind: string }> = {}) => ({
  id, kind: 'asr', sizeBytes, installed: false, needsSubscription: true, unsupportedReason: null, ...o,
});

describe('proToFetch', () => {
  it('fetches every missing Pro model, smallest first, and nothing Free', () => {
    const plan = proToFetch([
      row('whisper-base', 59_707_625, { needsSubscription: false }),
      row('whisper-small', 190_085_487),
      row('llm-qwen', 1_100_000_000, { kind: 'llm' }),
      row('embed-bge-small', 36_000_000, { kind: 'llm' }),
    ]);
    expect(plan.map(m => m.id)).toEqual(['embed-bge-small', 'whisper-small', 'llm-qwen']);
  });

  it('skips what is installed and what this phone cannot run', () => {
    const plan = proToFetch([
      row('whisper-small', 190_085_487),
      row('llm-qwen', 1_100_000_000, { kind: 'llm', unsupportedReason: 'This phone has 3 GB of memory.' }),
      row('embed-bge-small', 36_000_000, { kind: 'llm', installed: true }),
    ]);
    expect(plan.map(m => m.id)).toEqual(['whisper-small']);
  });

  it('has nothing to fetch on a phone that already has them', () => {
    expect(proToFetch([row('whisper-small', 1, { installed: true })])).toEqual([]);
  });
});
