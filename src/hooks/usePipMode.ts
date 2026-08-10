import { useEffect, useState } from 'react';
import { DeviceEventEmitter } from 'react-native';

/**
 * True while the app is in the Android Picture-in-Picture window. Driven by the native
 * `onPipModeChanged` event, which MainActivity emits over the global RCTDeviceEventEmitter.
 *
 * We subscribe via DeviceEventEmitter rather than `new NativeEventEmitter(NativeModules.Pip)`:
 * under the New Architecture `NativeModules.Pip` is a TurboModule and is not reliably present on
 * the legacy NativeModules object, which left the emitter wired to nothing and the event never
 * arriving. Device events are global, so DeviceEventEmitter receives it directly.
 */
export function usePipMode(): boolean {
  const [inPip, setInPip] = useState(false);
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('onPipModeChanged', (e: { inPip: boolean }) =>
      setInPip(!!e.inPip),
    );
    return () => sub.remove();
  }, []);
  return inPip;
}
