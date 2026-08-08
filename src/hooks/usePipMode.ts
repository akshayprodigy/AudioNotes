import { useEffect, useState } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';

/** True while the app is in the Android Picture-in-Picture window. Driven by onPipModeChanged. */
export function usePipMode(): boolean {
  const [inPip, setInPip] = useState(false);
  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.Pip);
    const sub = emitter.addListener('onPipModeChanged', (e: { inPip: boolean }) =>
      setInPip(!!e.inPip),
    );
    return () => sub.remove();
  }, []);
  return inPip;
}
