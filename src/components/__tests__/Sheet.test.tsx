import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Dimensions, ScrollView } from 'react-native';
import { Sheet, type SheetAction } from '../ui';

/**
 * Nine rows are taller than a 720-dp phone: on the A07 the grip and the title sat under the
 * status bar and the top row could not be reached. The card is capped at 85% of the window and
 * the rows scroll instead; the grip, the title and Cancel are not part of the scroll.
 */
describe('Sheet', () => {
  const actions: SheetAction[] = Array.from({ length: 9 }, (_, i) => ({
    icon: 'chat',
    label: `Row ${i + 1}`,
    onPress: jest.fn(),
  }));

  async function renderSheet() {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<Sheet visible title="More" actions={actions} onClose={jest.fn()} />);
    });
    return tree;
  }

  it('a long sheet scrolls instead of growing past the screen', async () => {
    const tree = await renderSheet();
    const scroll = tree.root.findByType(ScrollView);
    const buttons = scroll.findAllByProps({ accessibilityRole: 'button' }, { deep: false });
    expect(buttons.length).toBe(9);
    for (const a of actions) {
      expect(buttons.some(b => b.props.accessibilityLabel === a.label)).toBe(true);
    }
    let node = scroll.parent;
    while (node && !(node.props.style && [node.props.style].flat(Infinity).some((st: any) => st?.maxHeight != null))) {
      node = node.parent;
    }
    expect(node).not.toBeNull();
    const flat: Record<string, unknown> = [node!.props.style]
      .flat(Infinity)
      .reduce((acc: Record<string, unknown>, style) => Object.assign(acc, style), {});
    const windowHeight = Dimensions.get('window').height;
    expect(flat.maxHeight).toBeLessThanOrEqual(windowHeight * 0.85);
  });

  it('the title and Cancel are not inside the scroll', async () => {
    const tree = await renderSheet();
    const scroll = tree.root.findByType(ScrollView);
    expect(scroll.findAllByProps({ children: 'More' }, { deep: false })).toHaveLength(0);
    expect(scroll.findAllByProps({ children: 'Cancel' }, { deep: false })).toHaveLength(0);
    expect(tree.root.findAllByProps({ children: 'More' }, { deep: false })).toHaveLength(1);
    expect(tree.root.findAllByProps({ children: 'Cancel' }, { deep: false })).toHaveLength(1);
  });
});
