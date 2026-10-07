import { SAMPLE_ID, isSampleId, withoutSample } from '../sampleId';

describe('sample identification', () => {
  it('knows the sample by its id prefix and nothing else', () => {
    expect(isSampleId(SAMPLE_ID)).toBe(true);
    expect(isSampleId('sample-anything')).toBe(true);
    expect(isSampleId('3f2a9c1e-0b7d-4c55-9a52-61d0f4c0a1de')).toBe(false);
    expect(isSampleId('my-sample-recording')).toBe(false);
    expect(isSampleId('')).toBe(false);
    expect(isSampleId(null)).toBe(false);
    expect(isSampleId(undefined)).toBe(false);
  });

  it('keeps the sample out of the list every count is taken over', () => {
    const list = [{ id: 'a' }, { id: SAMPLE_ID }, { id: 'b' }];
    expect(withoutSample(list).map(m => m.id)).toEqual(['a', 'b']);
    expect(withoutSample([{ id: SAMPLE_ID }])).toEqual([]);
  });
});
