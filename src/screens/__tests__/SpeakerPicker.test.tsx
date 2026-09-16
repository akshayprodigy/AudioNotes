import React from 'react';
import renderer, { act } from 'react-test-renderer';
import SpeakerPicker from '../meeting/SpeakerPicker';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const speakers = [
  { id: 's1', meetingId: 'm', clusterLabel: 'S0', displayName: 'Speaker 1' },
  { id: 's2', meetingId: 'm', clusterLabel: 'S1', displayName: 'Priya' },
];

async function render(props: Partial<React.ComponentProps<typeof SpeakerPicker>> = {}) {
  const onPick = jest.fn();
  const onNew = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <SpeakerPicker
        visible
        lineText="Sure, after looking at the test results"
        speakers={speakers}
        currentId="s1"
        scopes
        onPick={onPick}
        onNew={onNew}
        onClose={() => {}}
        {...props}
      />,
    );
  });
  return { tree, onPick, onNew };
}

const press = async (tree: renderer.ReactTestRenderer, label: string) => {
  const node = tree.root.findAllByProps({ accessibilityLabel: label }, { deep: false })[0];
  await act(async () => {
    node.props.onPress();
  });
};

/** Who said it: every speaker, someone new, and the scope the change reaches. */
describe('SpeakerPicker', () => {
  it('lists every speaker and defaults the scope to just this line', async () => {
    const { tree, onPick } = await render();
    await press(tree, 'Priya');
    expect(onPick).toHaveBeenCalledWith('s2', 'line');
  });

  it('carries the chosen scope', async () => {
    const { tree, onPick } = await render();
    await press(tree, 'From here to the end of the turn');
    await press(tree, 'Priya');
    expect(onPick).toHaveBeenCalledWith('s2', 'rest');
  });

  it('offers someone new', async () => {
    const { tree, onNew } = await render();
    await press(tree, 'The whole turn');
    await press(tree, 'Someone new');
    expect(onNew).toHaveBeenCalledWith('turn');
  });

  it('hides the scope chips for a single-line turn or a turn-head tap, and picks the turn', async () => {
    const { tree, onPick } = await render({ scopes: false });
    expect(tree.root.findAllByProps({ accessibilityLabel: 'The whole turn' }, { deep: false })).toHaveLength(0);
    await press(tree, 'Priya');
    expect(onPick).toHaveBeenCalledWith('s2', 'turn');
  });
});
