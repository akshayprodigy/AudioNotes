import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import LibraryScreen from '../LibraryScreen';
import { db } from '../../db/queries';
import { useLibraryStore } from '../../state/libraryStore';
import { entitlement } from '../../billing/trial';
import { SAMPLE_ID } from '../../sample/sampleId';

jest.mock('../../db/queries');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../billing/trial', () => ({
  ...jest.requireActual('../../billing/trial'),
  entitlement: jest.fn(),
}));

/** "Add to project" from a meeting card's long-press menu (Workstream F). */
const nav = { navigate: jest.fn(), addListener: jest.fn(() => jest.fn()) } as never;
const route = { key: 'library', name: 'Library', params: undefined } as never;

const meeting = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `Meeting ${id}`, createdAt: Date.now(), durationMs: 600_000, language: 'en', status: 'done',
  tierUsed: 'free', audioRetained: 1, summaryLine: null, mode: null, ...over,
});

async function show() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<LibraryScreen navigation={nav} route={route} />);
  });
  return tree;
}
const texts = (t: renderer.ReactTestRenderer) =>
  t.root.findAll(n => n.type === Text).map(n => [n.props.children].flat().join(''));
const longPress = async (t: renderer.ReactTestRenderer) => {
  const card = t.root.findAll(n => typeof n.props.onLongPress === 'function' && typeof n.props.onPress === 'function')[0];
  await act(async () => card.props.onLongPress());
};

beforeEach(() => {
  jest.clearAllMocks();
  (db.listMeetings as jest.Mock).mockResolvedValue([meeting('a')]);
  (db.allTags as jest.Mock).mockResolvedValue([{ name: 'client', n: 2 }]);
  (db.tagsFor as jest.Mock).mockResolvedValue([]);
  (db.addTag as jest.Mock).mockResolvedValue(undefined);
  (db.getSetting as jest.Mock).mockResolvedValue(null);
  (db.archivedCount as jest.Mock).mockResolvedValue(0);
  (db.allActions as jest.Mock).mockResolvedValue([]);
  (db.doneItemIds as jest.Mock).mockResolvedValue(new Set<string>());
  (db.pendingMeetings as jest.Mock).mockResolvedValue([]);
  (entitlement as jest.Mock).mockResolvedValue({ paid: true });
  useLibraryStore.setState({
    backfillItems: jest.fn().mockResolvedValue(false),
    backfillSearch: jest.fn().mockResolvedValue(undefined),
    tag: null,
  });
});

describe('the Library long-press menu', () => {
  it('offers "Add to project" before Archive and Delete', async () => {
    const tree = await show();
    await longPress(tree);
    const all = texts(tree);
    const add = all.indexOf('Add to project');
    expect(add).toBeGreaterThanOrEqual(0);
    expect(add).toBeLessThan(all.indexOf('Archive'));
    await act(async () => tree.unmount());
  });

  it('opens the project sheet for that meeting; picking a project tags it and refreshes the library', async () => {
    const tree = await show();
    await longPress(tree);
    const row = tree.root.findAll(n => n.props.accessibilityLabel === 'Add to project' && typeof n.props.onPress === 'function')[0];
    await act(async () => row.props.onPress());
    expect(texts(tree)).toContain('YOUR PROJECTS');
    (db.listMeetings as jest.Mock).mockClear();
    const pick = tree.root.findAll(n => n.props.accessibilityLabel === 'Add to client' && typeof n.props.onPress === 'function')[0];
    await act(async () => pick.props.onPress());
    expect(db.addTag).toHaveBeenCalledWith('a', 'client');
    expect(db.listMeetings).toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('on Free the same entry opens a sheet that says Projects are part of Pro', async () => {
    (entitlement as jest.Mock).mockResolvedValue({ paid: false });
    const tree = await show();
    await longPress(tree);
    const row = tree.root.findAll(n => n.props.accessibilityLabel === 'Add to project' && typeof n.props.onPress === 'function')[0];
    await act(async () => row.props.onPress());
    expect(texts(tree)).toContain('Projects are part of Pro');
    expect(db.addTag).not.toHaveBeenCalled();
    // The upgrade button goes to the paywall rather than failing silently.
    const up = texts(tree).indexOf('Upgrade to Pro');
    expect(up).toBeGreaterThanOrEqual(0);
    const btn = tree.root.findAll(n => n.type === Text && [n.props.children].flat().join('') === 'Upgrade to Pro')[0];
    let p: any = btn;
    while (p && typeof p.props.onPress !== 'function') p = p.parent;
    await act(async () => p.props.onPress());
    expect((nav as any).navigate).toHaveBeenCalledWith('Paywall');
    await act(async () => tree.unmount());
  });

  it('is not offered on the sample meeting, whose menu is Delete sample only', async () => {
    (db.listMeetings as jest.Mock).mockResolvedValue([meeting(SAMPLE_ID)]);
    const tree = await show();
    await longPress(tree);
    expect(texts(tree)).not.toContain('Add to project');
    expect(texts(tree)).toContain('Delete sample');
    await act(async () => tree.unmount());
  });
});
