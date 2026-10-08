import React from 'react';
import { StyleSheet } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import ProNudgeCard from '../ProNudgeCard';

// Nothing A069: the card ran edge to edge above inset meeting cards. The Library's list has no side
// padding of its own - every child adds its own - so this card has to.
describe('ProNudgeCard', () => {
  it('is inset from the screen edge like the meeting cards under it', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ProNudgeCard meetings={5} onOpen={() => {}} onDismiss={() => {}} />);
    });
    const flat = tree.root
      .findAll(n => n.props.style !== undefined)
      .map(n => StyleSheet.flatten(n.props.style) as Record<string, unknown>);
    expect(flat.some(st => typeof st.marginHorizontal === 'number' && (st.marginHorizontal as number) > 0)).toBe(true);
  });

  it('says how many meetings, and offers both actions', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ProNudgeCard meetings={5} onOpen={() => {}} onDismiss={() => {}} />);
    });
    const text = tree.root
      .findAll(n => String(n.type) === 'Text')
      .map(n => [n.props.children].flat().join(''));
    expect(text).toContain('Your 5 meetings, written up');
    expect(text).toContain('See what it does');
    expect(text).toContain('Not now');
  });
});
