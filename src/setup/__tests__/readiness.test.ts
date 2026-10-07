import { essentialRows, essentialSize, readiness, readinessCopy, type Readiness, type RunState, type SetupRow } from '../readiness';

const MB = 1_000_000;
const row = (over: Partial<SetupRow> = {}): SetupRow => ({
  id: 'm',
  purpose: 'Speech to text',
  kind: 'asr',
  required: true,
  installed: false,
  sizeBytes: 60 * MB,
  heldBytes: 0,
  unsupportedReason: null,
  ...over,
});
/** The shipped first run: three required models, 114 MB in all. */
const THREE = [
  row({ id: 'vad', purpose: 'Voice detection', kind: 'vad', sizeBytes: 2 * MB }),
  row({ id: 'asr', purpose: 'Speech to text', sizeBytes: 60 * MB }),
  row({ id: 'diar', purpose: 'Who spoke', kind: 'diar', sizeBytes: 52 * MB }),
];
const idle: RunState = { running: false, failed: false, live: null };
/** A readiness that has a figure (every state but ready and unknown). */
const progress = (rows: SetupRow[], run: RunState) => readiness(rows, run) as Extract<Readiness, { pct: number }>;

describe('essentialRows / essentialSize', () => {
  it('takes only the required models this phone can run, never the Pro writer', () => {
    const writer = row({ id: 'llm', kind: 'llm', required: false, sizeBytes: 1100 * MB });
    const blocked = row({ id: 'x', required: true, unsupportedReason: 'Needs 4 GB' });
    expect(essentialRows([...THREE, writer, blocked]).map(r => r.id)).toEqual(['vad', 'asr', 'diar']);
  });

  it('sizes the download as the megabytes still to fetch, rounded like every other screen', () => {
    expect(essentialSize(THREE)).toBe(114);
    // Installed models cost nothing and are not counted.
    expect(essentialSize([{ ...THREE[0], installed: true }, THREE[1], THREE[2]])).toBe(112);
    expect(essentialSize([])).toBe(0);
  });
});

describe('readiness: the state machine', () => {
  it('is ready only when every essential model is installed', () => {
    expect(readiness(THREE.map(r => ({ ...r, installed: true })), idle).state).toBe('ready');
    expect(readiness([{ ...THREE[0], installed: true }, THREE[1], THREE[2]], idle).state).not.toBe('ready');
  });

  it('is unknown, not ready, when the catalog has not answered', () => {
    expect(readiness([], idle).state).toBe('unknown');
  });

  it('is notStarted when nothing is on disk and nothing is running', () => {
    const r = progress(THREE, idle);
    expect(r.state).toBe('notStarted');
    expect(r).toMatchObject({ totalMb: 114, pct: 0 });
  });

  it('is paused when part of it is on disk and nothing is running (skipped, killed, or a lost connection)', () => {
    const rows = [{ ...THREE[0], installed: true }, { ...THREE[1], heldBytes: 30 * MB }, THREE[2]];
    const r = progress(rows, idle);
    expect(r.state).toBe('paused');
    // 2 MB done + 30 MB partial of 114 MB.
    expect(r.pct).toBe(28);
  });

  it('is downloading while a run is going, and counts the live bytes of the model in flight', () => {
    const r = progress(THREE, { running: true, failed: false, live: { id: 'asr', downloaded: 45 * MB } });
    expect(r.state).toBe('downloading');
    expect(r.pct).toBe(39); // 45 of 114
  });

  it('never lets a stale held-bytes reading make the live figure go backwards', () => {
    const rows = [THREE[0], { ...THREE[1], heldBytes: 50 * MB }, THREE[2]];
    const r = progress(rows, { running: true, failed: false, live: { id: 'asr', downloaded: 10 * MB } });
    expect(r.pct).toBe(43); // 50 of 114 (43.9, floored), not 10
  });

  it('is failed after a run that errored, keeping what was already fetched', () => {
    const rows = [{ ...THREE[0], installed: true }, { ...THREE[1], heldBytes: 30 * MB }, THREE[2]];
    const r = progress(rows, { running: false, failed: true, live: null });
    expect(r.state).toBe('failed');
    expect(r.pct).toBe(28);
  });

  it('says downloading, not failed, once a retry is under way', () => {
    expect(readiness(THREE, { running: true, failed: true, live: null }).state).toBe('downloading');
  });

  it('is ready even if a stale failure is still remembered, because the models are there', () => {
    expect(readiness(THREE.map(r => ({ ...r, installed: true })), { running: false, failed: true, live: null }).state).toBe(
      'ready',
    );
  });

  it('clamps: a resumed part can report more bytes than the catalog expected', () => {
    const r = progress(THREE, { running: true, failed: false, live: { id: 'asr', downloaded: 900 * MB } });
    expect(r.pct).toBeLessThanOrEqual(99);
  });

  it('does not round up to 100 until it is actually ready', () => {
    const rows = THREE.map(r => ({ ...r, heldBytes: r.sizeBytes - 1 }));
    expect(progress(rows, idle).pct).toBe(99);
  });
});

describe('readinessCopy', () => {
  const rows = [{ ...THREE[0], installed: true }, { ...THREE[1], heldBytes: 30 * MB }, THREE[2]];

  it('names the percentage and the total, and the action, for each state', () => {
    expect(readinessCopy(readiness(rows, idle))).toEqual({
      title: 'Finish setup — 28% of 114 MB downloaded',
      action: 'Resume',
    });
    expect(readinessCopy(readiness(THREE, idle))).toEqual({
      title: 'Finish setup — 114 MB to download',
      action: 'Download',
    });
    expect(
      readinessCopy(readiness(rows, { running: true, failed: false, live: { id: 'asr', downloaded: 30 * MB } })),
    ).toEqual({ title: 'Downloading — 28% of 114 MB', action: null });
    expect(readinessCopy(readiness(rows, { running: false, failed: true, live: null }))).toEqual({
      title: 'Setup stopped — 28% of 114 MB downloaded. Check your connection.',
      action: 'Retry',
    });
  });

  it('has nothing to say when ready or unknown', () => {
    expect(readinessCopy(readiness(THREE.map(r => ({ ...r, installed: true })), idle))).toBeNull();
    expect(readinessCopy(readiness([], idle))).toBeNull();
  });
});
