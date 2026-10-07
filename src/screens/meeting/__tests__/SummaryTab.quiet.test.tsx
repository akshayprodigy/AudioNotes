import React from 'react';
import { StyleSheet } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import SummaryTab from '../SummaryTab';
import { SoftButton } from '../../../components/ui';

jest.mock('../../../native/NativeLicence', () => ({ __esModule: true, default: { status: jest.fn() } }));
jest.mock('../../../native/NativeLlm', () => ({
  __esModule: true,
  default: { available: jest.fn().mockResolvedValue(true), capable: jest.fn().mockResolvedValue(true) },
}));
jest.mock('../../../billing/trial', () => ({ __esModule: true, entitlement: jest.fn() }));
jest.mock('../../../billing/subscription', () => ({
  __esModule: true,
  playAvailable: jest.fn().mockResolvedValue(false),
  playPlans: jest.fn().mockResolvedValue([]),
  syncEntitlement: jest.fn().mockResolvedValue(undefined),
  licenceStatus: () => require('../../../native/NativeLicence').default.status(),
  PLAY_MANAGE_URL: 'x',
}));
import Licence from '../../../native/NativeLicence';
import { entitlement } from '../../../billing/trial';

const summary = { id: 'min-1', meetingId: 'm1', kind: 'summary', content: 'A short account of the meeting.', source: 'llm' };
const props = {
  items: [] as any[], minutes: [summary] as any[], speakers: [] as any[], speechMs: 60_000,
  highlights: [] as any[], onOpenProvenance: jest.fn(), canPlay: false, onRemoveMark: jest.fn(),
  onWrite: jest.fn(), onOpenTab: jest.fn(), writing: false, template: 'standup',
  onChangeTemplate: jest.fn(), onUpgrade: jest.fn(), stale: false,
};
async function draw(over: Record<string, unknown> = {}) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<SummaryTab {...(props as any)} {...over} />);
  });
  return tree;
}
const quiet = (t: renderer.ReactTestRenderer) =>
  t.root.findAll(n => typeof n.type === 'string' && n.props.accessibilityLabel === 'Write it again' && n.props.accessibilityRole === 'button');

beforeEach(() => {
  jest.clearAllMocks();
  (Licence.status as jest.Mock).mockResolvedValue({ state: 'active', paid: true, lapsedCopy: '' });
  (entitlement as jest.Mock).mockResolvedValue({ paid: true });
});

describe('"Write it again" is a secondary action', () => {
  it('is a quiet text action, not a raised button', async () => {
    const tree = await draw();
    expect(quiet(tree).length).toBeGreaterThan(0);
    expect(tree.root.findAllByType(SoftButton).filter(b => b.props.label === 'Write it again')).toHaveLength(0);
  });

  it('still writes the summary again when pressed', async () => {
    const tree = await draw();
    const pressable = tree.root.findAll(
      n => n.props.accessibilityLabel === 'Write it again' && typeof n.props.onPress === 'function',
    )[0];
    await act(async () => pressable.props.onPress());
    expect(props.onWrite).toHaveBeenCalledTimes(1);
  });

  it('sits after the summary itself, never before it', async () => {
    const tree = await draw();
    const json = JSON.stringify(tree.toJSON());
    expect(json.indexOf('A short account of the meeting.')).toBeGreaterThan(-1);
    expect(json.indexOf('A short account of the meeting.')).toBeLessThan(json.indexOf('Write it again'));
  });

  it('has a 44 dp target and says what it will do', async () => {
    const tree = await draw();
    const host = quiet(tree)[0];
    expect(StyleSheet.flatten(host.props.style).minHeight).toBeGreaterThanOrEqual(44);
    expect(host.props.accessibilityHint).toMatch(/current one stays/);
  });

  it('is disabled and says Working while a rewrite runs', async () => {
    const tree = await draw({ writing: true });
    expect(JSON.stringify(tree.toJSON())).toContain('Working…');
    expect(JSON.stringify(tree.toJSON())).not.toContain('"Write it again"');
    const busy = tree.root.findAll(n => n.props.accessibilityLabel === 'Working…' && typeof n.props.onPress === 'function')[0];
    expect(busy.props.disabled).toBe(true);
  });

  it('keeps the stale-summary notice and the action it points at', async () => {
    const tree = await draw({ stale: true });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain('You corrected the transcript after this summary was written');
    expect(quiet(tree).length).toBeGreaterThan(0);
  });

  it('keeps "Write the summary" a button where there is no summary yet', async () => {
    const tree = await draw({ minutes: [], transcriptChars: 5000 });
    expect(tree.root.findAllByType(SoftButton).some(b => b.props.label === 'Write the summary')).toBe(true);
  });
});
