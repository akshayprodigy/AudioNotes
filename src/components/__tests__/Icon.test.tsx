import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Circle, Path } from 'react-native-svg';
import Icon from '../Icon';

describe('Icon', () => {
  it('the gear is a cog: a hub circle inside a toothed outline', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<Icon name="gear" />);
    });
    expect(tree.root.findAllByType(Circle)).toHaveLength(1);
    expect(tree.root.findAllByType(Path)).toHaveLength(1);
    await act(async () => tree.unmount());
  });
});
