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

/**
 * On the Galaxy A07 the keyboard covered Cancel and Add of the two-field "Add a word" prompt, and
 * the second field's Done key only hid the keyboard. The card must move out from under the
 * keyboard, and Done on the last field must submit when both fields are filled.
 */
describe('TextPrompt and the keyboard', () => {
  it('sits inside a keyboard-avoiding view', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <TextPrompt visible title="Add a word" initial="" placeholder="hears" extraPlaceholder="mean" onCancel={noop} onSubmit={noop} />,
      );
    });
    const { KeyboardAvoidingView } = require('react-native');
    const kav = tree.root.findAllByType(KeyboardAvoidingView);
    expect(kav.length).toBe(1);
    expect(kav[0].props.behavior).toBe('padding');
    // The card is inside it, so it is what moves.
    expect(kav[0].findAllByType(TextInput).length).toBe(2);
  });

  it('Done on the second field submits both, and does nothing while the first is empty', async () => {
    const onSubmit = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <TextPrompt visible title="Add a word" initial="" placeholder="hears" extraPlaceholder="mean" onCancel={noop} onSubmit={onSubmit} />,
      );
    });
    const field = (i: number) => tree.root.findAllByType(TextInput)[i];
    await act(async () => {
      field(1).props.onChangeText('Innova');
    });
    await act(async () => {
      field(1).props.onSubmitEditing();
    });
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      field(0).props.onChangeText(' in over ');
    });
    await act(async () => {
      field(1).props.onSubmitEditing();
    });
    expect(onSubmit).toHaveBeenCalledWith('in over', 'Innova');
  });
});

// BACK with the keyboard up belongs to the keyboard (A07). The listeners are captured rather than
// emitted, so the test does not depend on a native event ever arriving in jest.
describe('TextPrompt and BACK (Step 6)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function withCapturedKeyboard() {
    const { Keyboard } = require('react-native');
    const handlers: Record<string, () => void> = {};
    jest.spyOn(Keyboard, 'addListener').mockImplementation((...args: unknown[]) => {
      const [event, cb] = args as [string, () => void];
      handlers[event] = cb;
      return { remove: jest.fn() };
    });
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    return { handlers, dismiss };
  }

  it('the first BACK closes the keyboard, not the prompt', async () => {
    const { handlers, dismiss } = withCapturedKeyboard();
    const { Modal } = require('react-native');
    const onCancel = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <TextPrompt visible title="Rename" initial="" placeholder="Name" onCancel={onCancel} onSubmit={noop} />,
      );
    });
    act(() => {
      handlers['keyboardDidShow']?.();
    });
    const modal = tree.root.findByType(Modal);
    act(() => {
      modal.props.onRequestClose();
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('BACK with no keyboard closes the prompt', async () => {
    const { handlers, dismiss } = withCapturedKeyboard();
    const { Modal } = require('react-native');
    const onCancel = jest.fn();
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <TextPrompt visible title="Rename" initial="" placeholder="Name" onCancel={onCancel} onSubmit={noop} />,
      );
    });
    act(() => {
      handlers['keyboardDidHide']?.();
    });
    const modal = tree.root.findByType(Modal);
    act(() => {
      modal.props.onRequestClose();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled();
  });
});
