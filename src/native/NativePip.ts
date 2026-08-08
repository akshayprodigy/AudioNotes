// TurboModule spec for native Picture-in-Picture. The window is entered natively on leave;
// JS only needs to know device support and when PiP mode toggles (event: onPipModeChanged).
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  isSupported(): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Pip');
