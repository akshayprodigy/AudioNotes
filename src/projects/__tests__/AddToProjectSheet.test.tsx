import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';
import AddToProjectSheet, { ADD_TO_PROJECT, useAddToProject } from '../AddToProjectSheet';
import { db } from '../../db/queries';
import { entitlement } from '../../billing/trial';

jest.mock('../../db/queries', () => ({
  ...jest.requireActual('../../db/queries'),
  db: { allTags: jest.fn(), tagsFor: jest.fn(), addTag: jest.fn() },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('../../billing/trial', () => ({ __esModule: true, entitlement: jest.fn() }));

const onClose = jest.fn();
const onChanged = jest.fn();
const onUpgrade = jest.fn();

async function show(visible = true) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <AddToProjectSheet
        visible={visible}
        meetingId="m1"
        meetingTitle="Standup"
        onClose={onClose}
        onChanged={onChanged}
        onUpgrade={onUpgrade}
      />,
    );
  });
  return tree;
}
const texts = (t: renderer.ReactTestRenderer) =>
  t.root.findAll(n => n.type === Text).map(n => [n.props.children].flat().join(''));
const press = (t: renderer.ReactTestRenderer, label: string) =>
  t.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0].props.onPress();
/** SoftButton's press lives on the Raised pressable beneath its text; find by visible label. */
const pressText = (t: renderer.ReactTestRenderer, label: string) => {
  const node = t.root.findAll(n => n.type === Text && [n.props.children].flat().join('') === label)[0];
  let p: any = node;
  while (p && typeof p.props.onPress !== 'function') p = p.parent;
  p.props.onPress();
};

beforeEach(() => {
  jest.clearAllMocks();
  (entitlement as jest.Mock).mockResolvedValue({ paid: true });
  (db.allTags as jest.Mock).mockResolvedValue([{ name: 'client', n: 3 }, { name: 'weekly', n: 1 }]);
  (db.tagsFor as jest.Mock).mockResolvedValue(['weekly']);
  (db.addTag as jest.Mock).mockResolvedValue(undefined);
});

describe('for Pro', () => {
  it('explains a project in one line and lists the existing ones', async () => {
    const tree = await show();
    const all = texts(tree);
    expect(all).toContain('Add to project');
    expect(all).toContain('A project groups meetings so you can see decisions and open actions together.');
    expect(all).toContain('client');
    expect(all).toContain('3 meetings');
    expect(all).toContain('weekly');
    expect(all).toContain('1 meeting');
    await act(async () => tree.unmount());
  });

  it('marks a project this meeting is already in, and does not add it twice', async () => {
    const tree = await show();
    const row = tree.root.findAll(n => n.props.accessibilityLabel === 'weekly, this meeting is already in it')[0];
    expect(row).toBeDefined();
    expect(row.props.disabled).toBe(true);
    await act(async () => tree.unmount());
  });

  it('applies an existing project as its tag, tells the caller and closes', async () => {
    const tree = await show();
    await act(async () => press(tree, 'Add to client'));
    expect(db.addTag).toHaveBeenCalledWith('m1', 'client');
    expect(onChanged).toHaveBeenCalledWith('client');
    expect(onClose).toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('creates a project by name: normalised, applied as the tag that makes the thread', async () => {
    const tree = await show();
    const input = tree.root.findByType(TextInput);
    await act(async () => input.props.onChangeText('  Launch   Plan '));
    expect(texts(tree)).toContain('Create “launch plan”');
    await act(async () => pressText(tree, 'Create “launch plan”'));
    expect(db.addTag).toHaveBeenCalledWith('m1', 'launch plan');
    expect(onChanged).toHaveBeenCalledWith('launch plan');
    await act(async () => tree.unmount());
  });

  it('submits from the keyboard with the same normalised name', async () => {
    const tree = await show();
    const input = tree.root.findByType(TextInput);
    await act(async () => input.props.onChangeText(' Board  Prep '));
    await act(async () => tree.root.findByType(TextInput).props.onSubmitEditing());
    expect(db.addTag).toHaveBeenCalledWith('m1', 'board prep');
    await act(async () => tree.unmount());
  });

  it('says "Add to" rather than "Create" when the typed name is a project already', async () => {
    const tree = await show();
    await act(async () => tree.root.findByType(TextInput).props.onChangeText('CLIENT'));
    expect(texts(tree)).toContain('Add to “client”');
    await act(async () => tree.unmount());
  });

  it('will not create from an empty name', async () => {
    const tree = await show();
    await act(async () => tree.root.findByType(TextInput).props.onChangeText('   '));
    await act(async () => pressText(tree, 'Create project'));
    expect(db.addTag).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('keeps the sheet open and the words when the write fails', async () => {
    (db.addTag as jest.Mock).mockRejectedValue(new Error('disk'));
    const tree = await show();
    await act(async () => tree.root.findByType(TextInput).props.onChangeText('launch'));
    await act(async () => pressText(tree, 'Create “launch”'));
    expect(onClose).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(texts(tree)).toContain('Could not save that. Try again.');
    expect(tree.root.findByType(TextInput).props.value).toBe('launch');
    await act(async () => tree.unmount());
  });

  it('invites the first project when there are none', async () => {
    (db.allTags as jest.Mock).mockResolvedValue([]);
    (db.tagsFor as jest.Mock).mockResolvedValue([]);
    const tree = await show();
    expect(texts(tree)).toContain('No projects yet. Name the first one below.');
    await act(async () => tree.unmount());
  });
});

describe('for Free', () => {
  beforeEach(() => (entitlement as jest.Mock).mockResolvedValue({ paid: false }));

  it('says Projects are part of Pro with the upgrade button, and lists and writes nothing', async () => {
    const tree = await show();
    const all = texts(tree);
    expect(all).toContain('Projects are part of Pro');
    expect(all).toContain('Upgrade to Pro');
    expect(all).not.toContain('YOUR PROJECTS');
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
    expect(db.allTags).not.toHaveBeenCalled();
    expect(db.addTag).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  it('the upgrade button closes the sheet and opens the paywall', async () => {
    const tree = await show();
    await act(async () => pressText(tree, 'Upgrade to Pro'));
    expect(onClose).toHaveBeenCalled();
    expect(onUpgrade).toHaveBeenCalledTimes(1);
    await act(async () => tree.unmount());
  });

  it('points to tags, which stay free', async () => {
    const tree = await show();
    expect(texts(tree).some(x => /Add a tag/.test(x))).toBe(true);
    await act(async () => tree.unmount());
  });

  it('does not flash the upsell at a Pro user while entitlement is still being read', async () => {
    let release!: (v: { paid: boolean }) => void;
    (entitlement as jest.Mock).mockReturnValue(new Promise(r => (release = r)));
    const tree = await show();
    expect(texts(tree)).not.toContain('Projects are part of Pro');
    expect(texts(tree)).not.toContain('YOUR PROJECTS');
    await act(async () => release({ paid: true }));
    expect(texts(tree)).toContain('YOUR PROJECTS');
    await act(async () => tree.unmount());
  });
});

it('reads nothing while hidden', async () => {
  const tree = await show(false);
  expect(entitlement).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});

describe('useAddToProject (the one hook the Meeting screen needs)', () => {
  function Harness() {
    const p = useAddToProject('m1', { onUpgrade, onChanged });
    return (
      <>
        <Text onPress={p.action.onPress}>{p.action.label}</Text>
        {p.sheet}
      </>
    );
  }
  it('offers the shared menu entry, and opening it shows the sheet', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<Harness />);
    });
    expect(entitlement).not.toHaveBeenCalled();
    expect(ADD_TO_PROJECT.label).toBe('Add to project');
    await act(async () => {
      tree.root.findAllByType(Text)[0].props.onPress();
    });
    expect(entitlement).toHaveBeenCalled();
    await act(async () => tree.unmount());
  });
});
