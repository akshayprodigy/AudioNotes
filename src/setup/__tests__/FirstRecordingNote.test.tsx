import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import FirstRecordingNote from '../FirstRecordingNote';
import { firstRecordingNote } from '../../billing/allowanceCopy';

const render = async (paid: boolean | null) => {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<FirstRecordingNote paid={paid} />);
  });
  return tree;
};

const texts = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);

describe('FirstRecordingNote', () => {
  it('says the language and the Free allowance on a Free phone, the language alone otherwise', async () => {
    expect(texts(await render(false))).toContain(firstRecordingNote(false));
    expect(texts(await render(true))).toContain(firstRecordingNote(true));
    expect(texts(await render(null))).toContain(firstRecordingNote(null));
  });

  // A Galaxy A07's first run showed the icon and no words: the Record screen centres its scroll
  // content, a centred card shrink-wraps, and text with flex: 1 inside shrink-wrapped width is
  // zero wide. Jest cannot lay anything out, so the guard is the contract that fixes it — the card
  // must be handed the full width by a stretching wrapper.
  it('is stretched to the width of its parent rather than shrink-wrapped by a centring one', async () => {
    const tree = await render(false);
    const wrap = tree.root.find(n => n.props.testID === 'first-recording-note');
    expect(StyleSheet.flatten(wrap.props.style)).toMatchObject({ alignSelf: 'stretch' });
  });
});
