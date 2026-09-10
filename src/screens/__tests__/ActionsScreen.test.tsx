import React from 'react';
import renderer, { act } from 'react-test-renderer';
import ActionsScreen from '../ActionsScreen';
import { db } from '../../db/queries';

jest.mock('../../db/queries');

// The screen loads its rows from useFocusEffect; outside a navigator that hook needs a stand-in,
// and running the callback on mount is exactly what focusing the screen does.
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => require('react').useEffect(cb, [cb]),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const nav = { navigate: jest.fn() } as any;
const route = { key: 'actions', name: 'Actions', params: undefined } as any;

const action = {
  meetingId: 'm1',
  meetingTitle: 'Standup',
  createdAt: 1,
  id: 'item-1',
  content: 'Send the report',
  source: 'rule',
  anchorStartMs: 5000,
};

// `deep: false` keeps this to one instance per checkbox: the role is passed down to the host
// views underneath the Pressable, so a plain findAllByProps counts each box three times.
const checkboxes = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAllByProps({ accessibilityRole: 'checkbox' }, { deep: false });

async function render() {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<ActionsScreen navigation={nav} route={route} />);
  });
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  (db.allActions as jest.Mock).mockResolvedValue([action]);
  (db.doneItemIds as jest.Mock).mockResolvedValue(new Set<string>());
  (db.setItemDone as jest.Mock).mockResolvedValue(undefined);
});

/**
 * The tick gesture on the cross-meeting worklist.
 *
 * What is being pinned is WHICH string reaches storage. The item's text used to be hashed and the
 * hash written, so the tick moved whenever the wording did; the write is the item's id now, and a
 * test that accepts a hash here is accepting the defect back.
 */
test('ticking an item writes the item id', async () => {
  const tree = await render();

  await act(async () => {
    tree.root.findByProps({ accessibilityRole: 'checkbox' }).props.onPress();
  });

  expect(db.setItemDone).toHaveBeenCalledWith('m1', 'item-1', true);
  // Not both stores. The per-meeting Actions tab writes `item_done` too since Task 10, and writing
  // to both would resurrect a tick the other screen had taken back: nothing sweeps `action_done`
  // on an untick made elsewhere.
  expect(db.setActionDone).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});

/**
 * The optimistic pass moves exactly the row that was tapped.
 *
 * Two items, one meeting, the same sentence — a phrase said twice, which the rules extract twice.
 * The old key was a hash of that sentence, so both rows shared it and the screen ticked both; the
 * id is the item, so only one moves. The write is left pending on purpose: what is being pinned is
 * the frame after the tap, not what the database eventually says.
 */
test('ticking one of two identically worded items moves only that one', async () => {
  let settle!: () => void;
  (db.setItemDone as jest.Mock).mockReturnValue(
    new Promise<void>(res => {
      settle = res;
    }),
  );
  (db.allActions as jest.Mock).mockResolvedValue([
    action,
    { ...action, id: 'item-2' },
  ]);
  const tree = await render();

  await act(async () => {
    checkboxes(tree)[0].props.onPress();
  });

  expect(db.setItemDone).toHaveBeenCalledWith('m1', 'item-1', true);
  expect(checkboxes(tree)).toHaveLength(1);

  await act(async () => settle());
  await act(async () => tree.unmount());
});

test('unticking a finished item takes the tick back', async () => {
  (db.doneItemIds as jest.Mock).mockResolvedValue(new Set(['m1\u0000item-1']));
  const tree = await render();

  // Finished items are folded away; open the fold to reach the one that is ticked.
  await act(async () => {
    tree.root.find(n => n.props.accessibilityState?.expanded === false).props.onPress();
  });
  await act(async () => {
    tree.root.findByProps({ accessibilityRole: 'checkbox' }).props.onPress();
  });

  expect(db.setItemDone).toHaveBeenCalledWith('m1', 'item-1', false);
  await act(async () => tree.unmount());
});
