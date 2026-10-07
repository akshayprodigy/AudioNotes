import {
  captureGapNote,
  gapSentence,
  gapsKey,
  loadCaptureGapNote,
  MIN_GAP_MS,
  normaliseGaps,
  parseGaps,
  totalSilencedMs,
  type Gap,
} from '../gaps';

const tail = " (a call, or another app) — that part wasn't recorded.";

describe('normaliseGaps', () => {
  it('merges overlapping intervals', () => {
    expect(normaliseGaps([[10_000, 20_000], [15_000, 30_000]], 60_000)).toEqual([[10_000, 30_000]]);
  });
  it('merges touching intervals', () => {
    expect(normaliseGaps([[10_000, 20_000], [20_000, 25_000]], 60_000)).toEqual([[10_000, 25_000]]);
  });
  it('absorbs a contained interval and ignores input order', () => {
    expect(normaliseGaps([[40_000, 50_000], [10_000, 30_000], [12_000, 14_000]], 60_000)).toEqual([
      [10_000, 30_000],
      [40_000, 50_000],
    ]);
  });
  it('keeps separate intervals separate', () => {
    expect(normaliseGaps([[0, 5_000], [5_001, 9_000]], 60_000)).toHaveLength(2);
  });
  it('drops anything under two seconds and keeps exactly two', () => {
    expect(MIN_GAP_MS).toBe(2_000);
    expect(normaliseGaps([[10_000, 11_999]], 60_000)).toEqual([]);
    expect(normaliseGaps([[10_000, 12_000]], 60_000)).toEqual([[10_000, 12_000]]);
  });
  it('applies the floor after the merge', () => {
    expect(normaliseGaps([[10_000, 11_500], [11_500, 13_000]], 60_000)).toEqual([[10_000, 13_000]]);
  });
  it('clamps to the recording length, and to zero', () => {
    expect(normaliseGaps([[50_000, 90_000]], 60_000)).toEqual([[50_000, 60_000]]);
    expect(normaliseGaps([[70_000, 90_000]], 60_000)).toEqual([]);
    expect(normaliseGaps([[-3_000, 5_000]], 60_000)).toEqual([[0, 5_000]]);
  });
  it('clamps before the floor', () => {
    expect(normaliseGaps([[59_000, 90_000]], 60_000)).toEqual([]);
  });
  it('does not change its input', () => {
    const g: Gap[] = [[10_000, 20_000], [15_000, 30_000]];
    normaliseGaps(g, 60_000);
    expect(g).toEqual([[10_000, 20_000], [15_000, 30_000]]);
  });
});

describe('totalSilencedMs', () => {
  it('sums the normalised intervals', () => {
    expect(
      totalSilencedMs([[10_000, 20_000], [15_000, 30_000], [40_000, 41_000], [50_000, 70_000]], 60_000),
    ).toBe(30_000);
  });
});

describe('gapSentence', () => {
  it('says min for minutes', () => {
    expect(gapSentence(4 * 60_000)).toBe(`Your phone's microphone was silenced for 4 min${tail}`);
  });
  it('counts seconds under a minute, singular for exactly one', () => {
    expect(gapSentence(45_000)).toBe(`Your phone's microphone was silenced for 45 seconds${tail}`);
    expect(gapSentence(59_999)).toContain('for 59 seconds ');
    expect(gapSentence(1_000)).toBe(`Your phone's microphone was silenced for 1 second${tail}`);
    expect(gapSentence(2_000)).toContain('for 2 seconds ');
  });
  it('has no sentence under a second', () => {
    expect(gapSentence(999)).toBeNull();
    expect(gapSentence(0)).toBeNull();
    expect(gapSentence(NaN)).toBeNull();
  });
  it('rounds to whole minutes from a minute up', () => {
    expect(gapSentence(60_000)).toContain('for 1 min ');
    expect(gapSentence(89_999)).toContain('for 1 min ');
    expect(gapSentence(90_000)).toContain('for 2 min ');
  });
});

describe('parseGaps', () => {
  it('reads the stored shape', () => {
    expect(parseGaps('[[1,2],[3,4]]')).toEqual([[1, 2], [3, 4]]);
  });
  it('never throws on missing or malformed text and skips odd entries', () => {
    expect(parseGaps(null)).toEqual([]);
    expect(parseGaps(undefined)).toEqual([]);
    expect(parseGaps('')).toEqual([]);
    expect(parseGaps('not json')).toEqual([]);
    expect(parseGaps('{"a":1}')).toEqual([]);
    expect(parseGaps('[[1],"x",[3,4],[5,"6"],[null,2]]')).toEqual([[3, 4]]);
  });
});

describe('captureGapNote / loadCaptureGapNote', () => {
  it('words the stored gaps against the recording length', () => {
    expect(captureGapNote('[[10000,250000]]', 600_000)).toBe(`Your phone's microphone was silenced for 4 min${tail}`);
  });
  it('is null for no key, an empty list, or only flickers', () => {
    expect(captureGapNote(null, 60_000)).toBeNull();
    expect(captureGapNote('[]', 60_000)).toBeNull();
    expect(captureGapNote('[[1000,2500]]', 60_000)).toBeNull();
  });
  it('reads the per-meeting key through getSetting', async () => {
    const getSetting = jest.fn().mockResolvedValue('[[0,60000]]');
    await expect(loadCaptureGapNote('m1', 120_000, getSetting)).resolves.toContain('for 1 min ');
    expect(getSetting).toHaveBeenCalledWith('capture_gaps:m1');
    expect(gapsKey('m1')).toBe('capture_gaps:m1');
  });
  it('is null when the read fails', async () => {
    await expect(loadCaptureGapNote('m1', 1, jest.fn().mockRejectedValue(new Error('db')))).resolves.toBeNull();
  });
});
