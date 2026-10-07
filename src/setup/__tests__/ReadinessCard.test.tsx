import React from 'react';
import renderer, { act } from 'react-test-renderer';
import ReadinessCard from '../ReadinessCard';
import { readiness, type RunState, type SetupRow } from '../readiness';
import type { Setup } from '../useReadiness';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const MB = 1_000_000;
const rows = (held: number, installedFirst = false): SetupRow[] => [
  { id: 'vad', purpose: 'Voice detection', kind: 'vad', required: true, installed: installedFirst, sizeBytes: 2 * MB, heldBytes: 0 },
  { id: 'asr', purpose: 'Speech to text', kind: 'asr', required: true, installed: false, sizeBytes: 60 * MB, heldBytes: held },
  { id: 'diar', purpose: 'Who spoke', kind: 'diar', required: true, installed: false, sizeBytes: 52 * MB, heldBytes: 0 },
];
const idle: RunState = { running: false, failed: false, live: null };

function setupFor(r: SetupRow[], run: RunState, fit: Setup['fit'] = { cpuReason: null, freeBytes: 10_000 * MB }) {
  return {
    rows: r,
    fit,
    state: readiness(r, run),
    start: jest.fn(async () => true),
    reload: jest.fn(),
  } as Setup;
}

const texts = (t: renderer.ReactTestRenderer) =>
  t.root.findAll(n => String(n.type) === 'Text').map(n => [n.props.children].flat().join(''));

async function show(setup: Setup) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ReadinessCard setup={setup} />);
  });
  return tree;
}

describe('the readiness card', () => {
  it('paused: names the progress and offers Resume, which starts the download', async () => {
    const setup = setupFor(rows(30 * MB), idle);
    const tree = await show(setup);
    expect(texts(tree)).toContain('Finish setup — 26% of 114 MB downloaded');
    const resume = tree.root.findByProps({ accessibilityLabel: 'Resume setup' });
    await act(async () => resume.props.onPress());
    expect(setup.start).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());
  });

  it('notStarted: says how much there is to download and offers Download', async () => {
    const tree = await show(setupFor(rows(0), idle));
    expect(texts(tree)).toContain('Finish setup — 114 MB to download');
    expect(tree.root.findByProps({ accessibilityLabel: 'Download setup' })).toBeTruthy();
    await act(async () => tree.unmount());
  });

  it('downloading: shows progress and offers no second button to start another run', async () => {
    const tree = await show(
      setupFor(rows(0), { running: true, failed: false, live: { id: 'asr', downloaded: 30 * MB } }),
    );
    expect(texts(tree)).toContain('Downloading — 26% of 114 MB');
    expect(tree.root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(0);
    await act(async () => tree.unmount());
  });

  it('failed: says it stopped, keeps what was fetched, and offers Retry', async () => {
    const setup = setupFor(rows(30 * MB), { running: false, failed: true, live: null });
    const tree = await show(setup);
    expect(texts(tree)).toContain('Setup stopped — 26% of 114 MB downloaded. Check your connection.');
    await act(async () => tree.root.findByProps({ accessibilityLabel: 'Retry setup' }).props.onPress());
    expect(setup.start).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());
  });

  it('ready: draws nothing at all', async () => {
    const all = rows(0).map(r => ({ ...r, installed: true }));
    const tree = await show(setupFor(all, idle));
    expect(tree.toJSON()).toBeNull();
  });

  it('unknown (catalog not answered): draws nothing rather than guess', async () => {
    const tree = await show(setupFor([], idle));
    expect(tree.toJSON()).toBeNull();
  });

  it('a phone the engines cannot run gets no card; onboarding is where that is said', async () => {
    const tree = await show(setupFor(rows(0), idle, { cpuReason: 'This phone is too old.', freeBytes: 10_000 * MB }));
    expect(tree.toJSON()).toBeNull();
  });

  it('too little free space: says so, in place of a button that would be refused', async () => {
    const tree = await show(setupFor(rows(0), idle, { cpuReason: null, freeBytes: 50 * MB }));
    expect(texts(tree).some(t => /needs 219 MB free; this phone has 50 MB free/.test(t))).toBe(true);
    expect(tree.root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(0);
    await act(async () => tree.unmount());
  });
});
