import React from 'react';
import { StyleSheet } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import PlayerBar from '../PlayerBar';

async function draw(over: Partial<React.ComponentProps<typeof PlayerBar>> = {}) {
  const props = { playing: false, positionMs: 65_000, durationMs: 600_000, onToggle: jest.fn(), onSeek: jest.fn(), ...over };
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<PlayerBar {...props} />);
  });
  return { tree, props };
}
const byLabel = (t: renderer.ReactTestRenderer, label: string) =>
  t.root.findAll(n => typeof n.type === 'string' && n.props.accessibilityLabel === label);

describe('the player controls for a screen reader', () => {
  it('has a Play button that says Pause while playing, at least 44 dp square', async () => {
    const idle = await draw();
    const play = byLabel(idle.tree, 'Play')[0];
    expect(play.props.accessibilityRole).toBe('button');
    const style = StyleSheet.flatten(play.props.style);
    expect(style.width).toBeGreaterThanOrEqual(44);
    expect(style.height).toBeGreaterThanOrEqual(44);
    const busy = await draw({ playing: true });
    expect(byLabel(busy.tree, 'Pause')).toHaveLength(1);
    expect(byLabel(busy.tree, 'Play')).toHaveLength(0);
  });

  it('toggles playback when pressed', async () => {
    const { tree, props } = await draw();
    const pressable = tree.root.findAll(n => n.props.accessibilityLabel === 'Play' && typeof n.props.onPress === 'function')[0];
    await act(async () => pressable.props.onPress());
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });

  it('is an adjustable position with its value in words and both actions declared', async () => {
    const { tree, props } = await draw();
    const slider = byLabel(tree, 'Playback position')[0];
    expect(slider.props.accessibilityRole).toBe('adjustable');
    expect(slider.props.accessibilityValue.text).toBe('01:05 of 10:00');
    // Declared, or the screen reader never lists them.
    expect(slider.props.accessibilityActions.map((a: { name: string }) => a.name)).toEqual(['increment', 'decrement']);
    await act(async () => slider.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }));
    expect(props.onSeek).toHaveBeenLastCalledWith(80_000);
    await act(async () => slider.props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } }));
    expect(props.onSeek).toHaveBeenLastCalledWith(50_000);
  });
});
