import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { DeviceEventEmitter, Text } from 'react-native';
import { usePipMode } from '../src/hooks/usePipMode';

// jest.setup.js replaces NativeEventEmitter with a dummy that never forwards events, so the plan's
// "emit on DeviceEventEmitter and watch the hook flip" would silently do nothing. Override it here
// to delegate to DeviceEventEmitter — which is exactly the global RCTDeviceEventEmitter channel the
// native side emits `onPipModeChanged` through — so the hook's subscription is genuinely exercised.
jest.mock('react-native/Libraries/EventEmitter/NativeEventEmitter', () => {
  const { DeviceEventEmitter } = require('react-native');
  return {
    __esModule: true,
    default: class {
      addListener(event: string, cb: (...args: any[]) => void) {
        return DeviceEventEmitter.addListener(event, cb);
      }
      removeAllListeners(event: string) {
        DeviceEventEmitter.removeAllListeners(event);
      }
      emit(event: string, ...args: any[]) {
        DeviceEventEmitter.emit(event, ...args);
      }
    },
  };
});

function Probe({ onValue }: { onValue: (v: boolean) => void }) {
  const inPip = usePipMode();
  onValue(inPip);
  return <Text>{String(inPip)}</Text>;
}

test('usePipMode flips with onPipModeChanged events', () => {
  let current = true; // seed with the wrong value so the initial `false` is a real assertion
  let tree: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<Probe onValue={v => (current = v)} />);
  });
  expect(current).toBe(false);

  act(() => {
    DeviceEventEmitter.emit('onPipModeChanged', { inPip: true });
  });
  expect(current).toBe(true);

  act(() => {
    DeviceEventEmitter.emit('onPipModeChanged', { inPip: false });
  });
  expect(current).toBe(false);

  act(() => tree.unmount());
});
