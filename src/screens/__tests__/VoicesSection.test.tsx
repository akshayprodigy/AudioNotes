import React from 'react';
import { Alert } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import VoicesSection from '../settings/VoicesSection';
import { Raised, SoftButton, Switch, Txt } from '../../components/ui';

// VoicesSection mounts a `Switch`, which starts an Animated timing on mount; fake timers stop
// the native-driver frame loop from firing after teardown (same convention as the screen tests).
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => jest.useRealTimers());

const baseProps = {
  paid: true,
  remember: false,
  onToggle: jest.fn(),
  onForget: jest.fn(),
  onUpgrade: jest.fn(),
};

async function render(props: Partial<typeof baseProps> = {}) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<VoicesSection {...baseProps} {...props} />);
  });
  return tree;
}

test('on Pro, the row reads "Remember voices" and the switch reflects the prop', async () => {
  const tree = await render();
  const label = tree.root
    .findAllByType(Txt)
    .find(t => String(t.props.children) === 'Remember voices');
  expect(label).toBeDefined();
  const sw = tree.root.findByType(Switch);
  expect(sw.props.on).toBe(false);
  await act(async () => {
    sw.props.onToggle();
  });
  expect(baseProps.onToggle).toHaveBeenCalledWith(true);
});

test('on free, the row reads "(Pro)", no switch, and the card opens the paywall', async () => {
  const onUpgrade = jest.fn();
  const tree = await render({ paid: false, onUpgrade });
  expect(tree.root.findAllByType(Switch)).toHaveLength(0);
  const label = tree.root
    .findAllByType(Txt)
    .find(t => String(t.props.children) === 'Remember voices (Pro)');
  expect(label).toBeDefined();
  const raised = tree.root.findByType(Raised);
  await act(async () => {
    raised.props.onPress();
  });
  expect(onUpgrade).toHaveBeenCalled();
});

test('the explanation paragraph is present verbatim', async () => {
  const tree = await render();
  const txt = tree.root
    .findAllByType(Txt)
    .find(t => String(t.props.children).includes('Nothing is uploaded and nothing leaves the phone.'));
  expect(txt).toBeDefined();
});

test('Forget opens a confirm dialog and deletes on "Forget"; "Cancel" does not', async () => {
  const onForget = jest.fn();
  const tree = await render({ onForget });
  const btn = tree.root.findByProps({ label: 'Forget all voices' }) as any;
  await act(async () => {
    btn.props.onPress();
  });
  expect(Alert.alert).toHaveBeenCalledTimes(1);
  expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Forget all voices?');
  const buttons: any[] = (Alert.alert as jest.Mock).mock.calls[0][2];
  const forget = buttons.find(b => b.text === 'Forget');
  const cancel = buttons.find(b => b.text === 'Cancel');
  await act(async () => {
    forget.onPress();
  });
  expect(onForget).toHaveBeenCalledTimes(1);
  expect(cancel.onPress).toBeUndefined();
});
