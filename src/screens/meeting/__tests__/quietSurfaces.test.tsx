import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Raised } from '../../../components/ui';
import MinutesTab from '../MinutesTab';
import ActionsTab from '../ActionsTab';
import TranscriptTab from '../TranscriptTab';

jest.mock('../../../db/queries', () => ({
  db: {
    doneItems: jest.fn().mockResolvedValue(new Set()),
    doneActions: jest.fn().mockResolvedValue(new Set()),
    setItemDone: jest.fn().mockResolvedValue(undefined),
    setActionDone: jest.fn().mockResolvedValue(undefined),
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

/**
 * Quieter reading surfaces (Workstream D). The Minutes, Actions and Transcript tabs are READ, often
 * for a long time, and a raised 3-D card around every item turned twenty items into a pile. Rows
 * are flat now, separated by hairlines, on theme tokens only. There is little behaviour to test, so
 * this pins the two things that would quietly come back: a Raised wrapper per item, and a colour
 * written into a screen instead of read from the theme.
 */
const item = (i: number, kind: string) => ({
  id: `it${i}`, meetingId: 'm1', kind, text: `Thing number ${i} — Priya`, review: 'suggested', genVersion: 'rules@1',
  itemType: null, status: null, ownerJson: null, dateSaid: null, dateNorm: null,
  anchorStartMs: i * 1000, anchorEndMs: i * 1000 + 500, sources: [],
});
const many = (n: number) => [
  ...Array.from({ length: n }, (_, i) => item(i, 'decision')),
  ...Array.from({ length: n }, (_, i) => item(100 + i, 'action')),
  ...Array.from({ length: n }, (_, i) => item(200 + i, 'question')),
];
const raisedCount = async (el: React.ReactElement) => {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(el);
  });
  const n = tree.root.findAllByType(Raised).length;
  await act(async () => tree.unmount());
  return n;
};

describe('reading rows are flat', () => {
  it('the Minutes tab draws no more raised surfaces for 15 items than for 3', async () => {
    const f = (n: number) => raisedCount(<MinutesTab items={many(n) as never} minutes={[]} onExport={() => {}} />);
    expect(await f(5)).toBe(await f(1));
  });

  it('the Actions tab draws no more raised surfaces for 15 items than for 3', async () => {
    const f = (n: number) => raisedCount(<ActionsTab meetingId="m1" items={many(n) as never} minutes={[]} />);
    expect(await f(5)).toBe(await f(1));
  });

  it('the Transcript tab draws no raised surface per turn', async () => {
    const utts = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `u${i}`, meetingId: 'm1', startMs: i * 60_000, endMs: i * 60_000 + 1000, speakerId: i % 2 ? 's2' : 's1', text: `Line ${i}.`,
      }));
    const speakers = [
      { id: 's1', meetingId: 'm1', clusterLabel: 'S0', displayName: 'Priya' },
      { id: 's2', meetingId: 'm1', clusterLabel: 'S1', displayName: 'Sam' },
    ];
    const f = (n: number) => raisedCount(<TranscriptTab utterances={utts(n) as never} speakers={speakers as never} />);
    expect(await f(6)).toBe(0);
    expect(await f(1)).toBe(0);
  });
});

describe('the reading surfaces use the theme and nothing else', () => {
  const dir = path.join(__dirname, '..');
  const files = [
    'MinutesTab.tsx', 'ActionsTab.tsx', 'TranscriptTab.tsx', 'SummaryTab.tsx', 'shared.tsx',
    'AskEntry.tsx', 'Heading.tsx', 'ItemProvenance.tsx', 'takeaway.ts', 'askAccess.ts',
  ];
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
  // Comments may mention a colour; code may not.
  const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it.each(files)('%s writes no colour literal', f => {
    expect(code(f)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code(f)).not.toMatch(/rgba?\(/);
  });

  it('only the Summary tab still imports Raised, and only for its two attention banners', () => {
    for (const f of ['MinutesTab.tsx', 'ActionsTab.tsx', 'TranscriptTab.tsx', 'shared.tsx']) {
      expect(code(f)).not.toMatch(/\bRaised\b/);
    }
    expect(code('SummaryTab.tsx').match(/<Raised\b/g)).toHaveLength(2);
  });
});
