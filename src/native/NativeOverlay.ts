// TurboModule spec for the floating recorder bubble (overlay on top of other apps).
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  hasPermission(): Promise<boolean>; // "display over other apps"
  requestPermission(): Promise<void>; // opens the system settings screen
  show(): Promise<void>; // show the floating bubble
  hide(): Promise<void>; // remove it
  isRecording(): Promise<boolean>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Overlay');
