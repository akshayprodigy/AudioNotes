import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Rect, Svg } from 'react-native-svg';
import { GradientFill } from '../ui';

/**
 * The Summary card's gradient stopped short of the card on the Galaxy A07: the card grows once
 * its copy arrives (an async entitlement check decides which sentence), and a Rect sized in
 * percent inside an absoluteFill Svg is not re-rasterised when only the layout changes — the
 * bottom of the card showed the flat base colour. The fill measures its box and draws in numbers,
 * so growth is a prop change and the gradient follows.
 */
describe('GradientFill', () => {
  const layout = (w: number, h: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width: w, height: h } } });

  it('draws nothing until it has a size, then draws exactly that size', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<GradientFill from="#000" to="#fff" />);
    });
    expect(tree.root.findAllByType(Svg)).toHaveLength(0);
    const { View } = require('react-native');
    const box = tree.root.findAllByType(View)[0];
    await act(async () => {
      box.props.onLayout(layout(300, 120));
    });
    const rect = tree.root.findByType(Rect);
    expect([rect.props.width, rect.props.height]).toEqual([300, 120]);
    const svg = tree.root.findByType(Svg);
    expect([svg.props.width, svg.props.height]).toEqual([300, 120]);
  });

  it('follows the box when it grows', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<GradientFill from="#000" to="#fff" />);
    });
    const { View } = require('react-native');
    const box = tree.root.findAllByType(View)[0];
    await act(async () => {
      box.props.onLayout(layout(300, 120));
    });
    await act(async () => {
      box.props.onLayout(layout(300, 260));
    });
    expect(tree.root.findByType(Rect).props.height).toBe(260);
  });
});
