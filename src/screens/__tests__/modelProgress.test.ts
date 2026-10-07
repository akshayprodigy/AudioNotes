import { dropInstalled, isDownloadComplete } from '../modelProgress';

describe('isDownloadComplete', () => {
  it('is the final (size, size) event, and nothing before it', () => {
    expect(isDownloadComplete(1100, 1100)).toBe(true);
    expect(isDownloadComplete(1101, 1100)).toBe(true); // a resumed download can overshoot
    expect(isDownloadComplete(1099, 1100)).toBe(false);
  });
  it('is not true of an event that has no total yet', () => {
    expect(isDownloadComplete(0, 0)).toBe(false);
  });
});

describe('dropInstalled', () => {
  const p = { a: { downloaded: 1, total: 2 }, b: { downloaded: 2, total: 2 } };
  it('drops only the entries whose model is installed', () => {
    expect(dropInstalled(p, [{ id: 'a', installed: false }, { id: 'b', installed: true }])).toEqual({
      a: { downloaded: 1, total: 2 },
    });
  });
  it('returns the same object when nothing changes, so a state update does not re-render', () => {
    const models = [{ id: 'a', installed: false }];
    expect(dropInstalled(p, models)).toBe(p);
  });
});
