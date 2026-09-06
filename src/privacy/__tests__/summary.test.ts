import { summarise, formatBytes, type NetworkEvent } from '../summary';

const AUG = Date.UTC(2026, 7, 20, 12, 0, 0); // 20 August 2026
const SEP_1 = Date.UTC(2026, 8, 1, 0, 0, 0);
const SEP_6 = Date.UTC(2026, 8, 6, 12, 0, 0);

const events: NetworkEvent[] = [
  {
    id: 1, at: AUG, kind: 'models', host: 'huggingface.co',
    sent: 0, received: 57_000_000, detail: 'ggml-base-q5_1.bin',
  },
  {
    id: 2, at: SEP_1, kind: 'licence', host: 'licence.innocorelabs.com',
    sent: 180, received: 620, detail: 'token refresh',
  },
  {
    id: 3, at: SEP_6, kind: 'licence', host: 'licence.innocorelabs.com',
    sent: 210, received: 640, detail: 'sign in',
  },
];

describe('what the privacy screen reports', () => {
  it('counts only the current calendar month in the headline', () => {
    // August's download is real and stays in the log; it is not "this month".
    const s = summarise(events, SEP_6);
    expect(s.callsThisMonth).toBe(2);
    expect(s.sentThisMonth).toBe(390);
  });

  it('reports the one-time setup download over all time, not this month', () => {
    // It is the largest number on the screen and it is the argument, so it must not vanish on
    // the first of the month.
    const s = summarise(events, SEP_6);
    expect(s.setupDownloadBytes).toBe(57_000_000);
    expect(s.setupHosts).toEqual(['huggingface.co']);
  });

  it('is zero for somebody who has never signed in', () => {
    const s = summarise([], SEP_6);
    expect(s.callsThisMonth).toBe(0);
    expect(s.sentThisMonth).toBe(0);
    expect(s.setupDownloadBytes).toBe(0);
  });

  it('never counts audio, because nothing can record audio into the ledger', () => {
    // The zero on the screen is derived from the kinds that exist, not printed as a constant.
    const s = summarise(events, SEP_6);
    expect(s.audioBytes).toBe(0);
  });

  it('names every host it has ever talked to, deduplicated and stable', () => {
    const s = summarise(events, SEP_6);
    expect(s.allHosts).toEqual(['huggingface.co', 'licence.innocorelabs.com']);
  });

  it('formats bytes the way a person reads them', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(390)).toBe('390 bytes');
    expect(formatBytes(57_000_000)).toBe('57.0 MB');
    expect(formatBytes(1_300_000_000)).toBe('1.3 GB');
  });
});
