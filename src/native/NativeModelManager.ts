// TurboModule spec for on-device model files. Models download on first run, NOT bundled
// (a 2.5GB APK kills install conversion). Staged, resumable, checksum-verified.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  list(): Promise<string>; // JSON: installed models + sizes
  download(modelId: string): Promise<void>; // emits 'onModelProgress' events
  remove(modelId: string): Promise<void>;
  verify(modelId: string): Promise<boolean>; // sha256 check
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('ModelManager');
