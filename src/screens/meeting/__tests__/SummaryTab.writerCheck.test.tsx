import React from 'react';
import renderer, { act } from 'react-test-renderer';
import SummaryTab from '../SummaryTab';

/**
 * F24: the quiet line under the summary when the writer's fact check removed sentences. The count
 * is read from the settings key Narrator.kt writes; it must show only while the model's own text
 * is on the card, and a re-run must replace it.
 */
const mockSettings = new Map<string, string>();

jest.mock('../../../native/NativeLicence', () => ({
  __esModule: true,
  default: { status: jest.fn(async () => ({ state: 'active', lapsedCopy: '' })) },
}));
jest.mock('../../../native/NativeLlm', () => ({
  __esModule: true,
  default: { available: jest.fn(async () => true), capable: jest.fn(async () => true) },
}));
jest.mock('../../../billing/trial', () => ({
  __esModule: true,
  entitlement: jest.fn(async () => ({ paid: true })),
}));
jest.mock('../../../billing/subscription', () => ({
  __esModule: true,
  playAvailable: jest.fn().mockResolvedValue(false),
  playPlans: jest.fn().mockResolvedValue([]),
  syncEntitlement: jest.fn().mockResolvedValue(undefined),
  licenceStatus: () => require('../../../native/NativeLicence').default.status(),
  PLAY_MANAGE_URL: 'https://play.google.com/store/account/subscriptions',
}));
jest.mock('../../../db/queries', () => ({
  db: {
    getSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
  },
}));

const minute = (id: string, content: string) => ({
  id,
  meetingId: 'm1',
  kind: 'summary',
  content,
  source: 'llm',
});

const baseProps = {
  items: [] as any[],
  minutes: [minute('a', 'A short account of the meeting.')] as any[],
  speakers: [] as any[],
  speechMs: 60_000,
  highlights: [] as any[],
  onOpenProvenance: jest.fn(),
  canPlay: false,
  onRemoveMark: jest.fn(),
  onWrite: jest.fn(),
  onOpenTab: jest.fn(),
  writing: false,
  template: null as string | null,
  onChangeTemplate: jest.fn(),
  threads: [] as { tag: string; open: number; decisions: number }[],
  onOpenThread: jest.fn(),
  voiceSuggestions: [] as string[],
  onConfirmVoices: jest.fn(),
  transcriptChars: undefined as number | undefined,
  onUpgrade: jest.fn(),
  onEdit: jest.fn(),
  onCopy: jest.fn(),
};

async function renderTab(props: Partial<typeof baseProps & { edits: Map<string, string> }> = {}) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<SummaryTab {...baseProps} {...(props as any)} />);
  });
  return tree;
}
const texts = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);
const REMOVED = /removed because the transcript/;

beforeEach(() => {
  mockSettings.clear();
});

describe('the removed-sentences line', () => {
  test('shows the count the narrator recorded for this meeting', async () => {
    mockSettings.set('writer_check:m1', '2|currency,tense');
    const tree = await renderTab();
    expect(texts(tree)).toContain("2 sentences removed because the transcript doesn't support them.");
  });

  test('says nothing for a clean narration or a meeting with no record', async () => {
    mockSettings.set('writer_check:m1', '0|');
    expect(texts(await renderTab()).some(t => REMOVED.test(t))).toBe(false);
    mockSettings.clear();
    expect(texts(await renderTab()).some(t => REMOVED.test(t))).toBe(false);
  });

  test("a different meeting's count is not shown", async () => {
    mockSettings.set('writer_check:other', '5|number');
    expect(texts(await renderTab()).some(t => REMOVED.test(t))).toBe(false);
  });

  test('says nothing when there is no written summary to describe', async () => {
    mockSettings.set('writer_check:m1', '2|date');
    const tree = await renderTab({ minutes: [] });
    expect(texts(tree).some(t => REMOVED.test(t))).toBe(false);
  });

  test('a re-run replaces the line instead of leaving the last count under it', async () => {
    mockSettings.set('writer_check:m1', '3|number');
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SummaryTab {...baseProps} />);
    });
    expect(texts(tree).some(t => /^3 sentences/.test(t))).toBe(true);
    mockSettings.set('writer_check:m1', '0|');
    await act(async () => {
      tree.update(<SummaryTab {...baseProps} minutes={[minute('b', 'A fresh account.')] as any[]} />);
    });
    expect(texts(tree).some(t => REMOVED.test(t))).toBe(false);
  });

  test("is hidden once the person's own words are on the card", async () => {
    mockSettings.set('writer_check:m1', '2|date');
    const edits = new Map([['summary/doc', 'My own summary.']]);
    const tree = await renderTab({ edits });
    expect(texts(tree).some(t => REMOVED.test(t))).toBe(false);
  });
});
