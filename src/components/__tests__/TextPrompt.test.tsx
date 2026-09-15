import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { TextInput } from 'react-native';
import { TextPrompt } from '../ui';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const noop = () => {};

async function inputs(multiline?: boolean) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <TextPrompt visible title="Rename" initial="" placeholder="Name" multiline={multiline} onCancel={noop} onSubmit={noop} />,
    );
  });
  return tree.root.findAllByType(TextInput);
}

/**
 * A title or a tag is one line. On the Pixel, pasting a whole exported document into "Rename this
 * meeting" grew the field to four thousand characters and pushed Cancel and Save off the screen;
 * the only way out was to empty the field by hand. A single-line prompt caps what it will hold.
 */
describe('TextPrompt', () => {
  it('caps a single-line prompt at a title-sized length', async () => {
    const [input] = await inputs(undefined);
    expect(input.props.maxLength).toBe(TextPrompt.SINGLE_LINE_MAX);
    expect(TextPrompt.SINGLE_LINE_MAX).toBeGreaterThanOrEqual(80);
    expect(TextPrompt.SINGLE_LINE_MAX).toBeLessThanOrEqual(200);
  });

  it('leaves a multi-line prompt uncapped — a corrected transcript line can be long', async () => {
    const [input] = await inputs(true);
    expect(input.props.maxLength).toBeUndefined();
  });
});
