/**
 * What a download says about itself while it runs.
 *
 * The reason these exist: the writer model is 1.1 GB, a percentage moves once every ten seconds on
 * it, and a number that does not move looks broken. The megabyte figure is what tells somebody the
 * download is alive, so it has to be right at both ends of the scale and while the total is still
 * unknown.
 */
import { downloadLabel, downloadPct, size } from '../downloadLabel';

describe('size', () => {
  it('uses MB below a gigabyte and GB above it', () => {
    expect(size(114_000_000)).toBe('114 MB');
    expect(size(1_117_320_736)).toBe('1.1 GB');
  });

  it('never shows a bare 0 MB for a download that has started', () => {
    expect(size(4_096)).toBe('4 KB');
  });

  it('survives nothing, negatives and nonsense', () => {
    expect(size(0)).toBe('0 MB');
    expect(size(-1)).toBe('0 MB');
    expect(size(NaN)).toBe('0 MB');
  });
});

describe('downloadLabel', () => {
  it('leads with the bytes, because they are what visibly move', () => {
    expect(downloadLabel(412_000_000, 1_117_320_736)).toBe('412 MB of 1.1 GB · 37%');
  });

  it('shows only a percentage before the first event carries a total', () => {
    expect(downloadLabel(0, 0)).toBe('0%');
  });

  it('does not go past 100% when a resumed download over-reports', () => {
    expect(downloadLabel(1_200_000_000, 1_117_320_736)).toContain('100%');
    expect(downloadPct(1_200_000_000, 1_117_320_736)).toBe(100);
  });

  it('gives the bar nothing to draw until a total is known', () => {
    expect(downloadPct(500, 0)).toBe(0);
  });
});
