import React from 'react';
import renderer, { act } from 'react-test-renderer';
import ThreadScreen from '../ThreadScreen';
import { db } from '../../db/queries';
import { SectionHead } from '../meeting/shared';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// The thread screen re-reads on every focus (§2.4 of the brief), the way ActionsScreen does;
// outside a real navigator that hook needs a stand-in, and running the callback on mount is
// exactly what focusing the screen does.
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => require('react').useEffect(cb, [cb]),
}));

const nav = { navigate: jest.fn(), goBack: jest.fn() } as any;
const route = { key: 'thread', name: 'Thread', params: { tag: 'ops' } } as any;

function flatten(node: unknown, out: string[]): void {
  if (node == null) return;
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach(n => flatten(n, out));
    return;
  }
  if (typeof node === 'object' && 'children' in (node as any)) flatten((node as any).children, out);
}

/** Every rendered string leaf, in visual order — robust for order/count checks that a component
 * query would otherwise have to fight prop-forwarding duplication (Pressable onto its host View) for. */
function allText(tree: renderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  flatten(tree.toJSON(), out);
  return out;
}

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ThreadScreen navigation={nav} route={route} />);
  });
  return tree;
}

const fixture = {
  tag: 'ops',
  meetings: [
    { id: 'm2', title: 'Ops weekly, 10 Sep', createdAt: 10, template: null },
    { id: 'm1', title: 'Ops weekly, 3 Sep', createdAt: 3, template: null },
  ],
  open: [
    { itemId: 'a1', meetingId: 'm2', meetingTitle: 'Ops weekly', meetingAt: 10, content: 'Draft the mapping table — Priya (due tomorrow)', itemType: null, status: null, dateNorm: null },
    { itemId: 'a2', meetingId: 'm1', meetingTitle: 'Ops weekly', meetingAt: 3, content: 'Check with finance — Ravi (due Friday)', itemType: null, status: null, dateNorm: null },
  ],
  decisions: [
    { itemId: 'd1', meetingId: 'm1', meetingTitle: 'Ops weekly', meetingAt: 3, content: 'Vendor codes will be six digits.', itemType: null, status: null, changes: null },
    { itemId: 'd2', meetingId: 'm2', meetingTitle: 'Ops weekly', meetingAt: 10, content: 'Existing vendors keep their old codes.', itemType: null, status: null, changes: null },
    { itemId: 'd3', meetingId: 'm2', meetingTitle: 'Ops weekly', meetingAt: 10, content: 'Shipping moved to Thursday.', itemType: null, status: null, changes: { itemId: 'd1', content: 'Vendor codes will be six digits.', meetingAt: 3 } },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
});

test('renders the three section heads', async () => {
  (db.thread as jest.Mock).mockResolvedValue(fixture);
  const tree = await render();
  const heads = tree.root.findAllByType(SectionHead).map(n => n.props.label);
  expect(heads).toEqual(['STILL OPEN', 'DECISIONS SO FAR', 'MEETINGS']);
  await act(async () => tree.unmount());
});

test('an open row shows owner and due, and the meeting title', async () => {
  (db.thread as jest.Mock).mockResolvedValue(fixture);
  const tree = await render();
  const row = tree.root.findByProps({ accessibilityLabel: 'Draft the mapping table' });
  const texts = row.findAllByType(require('../../components/ui').Txt).map(n => n.props.children);
  const flat = texts.flat(Infinity).join(' ');
  expect(flat).toContain('Priya');
  expect(flat).toContain('due tomorrow');
  expect(flat).toContain('Ops weekly');
  await act(async () => tree.unmount());
});

test('decisions render oldest first, and only the third shows "changes:"', async () => {
  (db.thread as jest.Mock).mockResolvedValue(fixture);
  const tree = await render();

  const texts = allText(tree);
  const order = ['Vendor codes will be six digits.', 'Existing vendors keep their old codes.', 'Shipping moved to Thursday.']
    .map(text => texts.findIndex(t => t.includes(text)));
  expect(order.every(i => i >= 0)).toBe(true);
  expect(order[0]).toBeLessThan(order[1]);
  expect(order[1]).toBeLessThan(order[2]);

  const changesLines = texts.filter(t => t.startsWith('changes:'));
  expect(changesLines).toEqual(['changes: "Vendor codes will be six digits." (Thu 1 Jan)']);
  await act(async () => tree.unmount());
});

test('tapping an open row navigates to its meeting', async () => {
  (db.thread as jest.Mock).mockResolvedValue(fixture);
  const tree = await render();
  const row = tree.root.findByProps({ accessibilityLabel: 'Draft the mapping table' });
  await act(async () => {
    row.props.onPress();
  });
  expect(nav.navigate).toHaveBeenCalledWith('Meeting', { meetingId: 'm2' });
  await act(async () => tree.unmount());
});

test('tapping a decision row navigates to its meeting', async () => {
  (db.thread as jest.Mock).mockResolvedValue(fixture);
  const tree = await render();
  const row = tree.root.findByProps({ accessibilityLabel: 'Vendor codes will be six digits.' });
  await act(async () => {
    row.props.onPress();
  });
  expect(nav.navigate).toHaveBeenCalledWith('Meeting', { meetingId: 'm1' });
  await act(async () => tree.unmount());
});

test('tapping a meeting row navigates to it too', async () => {
  (db.thread as jest.Mock).mockResolvedValue(fixture);
  const tree = await render();
  const row = tree.root.findByProps({ accessibilityLabel: 'Open Ops weekly, 10 Sep' });
  await act(async () => {
    row.props.onPress();
  });
  expect(nav.navigate).toHaveBeenCalledWith('Meeting', { meetingId: 'm2' });
  await act(async () => tree.unmount());
});

test('an empty thread renders both empty-state lines', async () => {
  (db.thread as jest.Mock).mockResolvedValue({ tag: 'ops', meetings: [{ id: 'm1', title: 'Ops weekly', createdAt: 3, template: null }], open: [], decisions: [] });
  const tree = await render();
  const allTxt = tree.root.findAllByType(require('../../components/ui').Txt).map(n => n.props.children);
  expect(allTxt).toContainEqual('Nothing open in this thread.');
  expect(allTxt).toContainEqual('No decisions yet.');
  await act(async () => tree.unmount());
});

test('a NOT_PRO refusal navigates to the paywall and renders no section head', async () => {
  (db.thread as jest.Mock).mockResolvedValue({ refusal: 'NOT_PRO' });
  const tree = await render();
  expect(nav.navigate).toHaveBeenCalledWith('Paywall');
  expect(tree.root.findAllByType(SectionHead)).toHaveLength(0);
  await act(async () => tree.unmount());
});
