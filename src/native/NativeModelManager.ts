// TurboModule spec for on-device model files. Models download on first run, NOT bundled
// (a 2.5GB APK kills install conversion). Staged, resumable, checksum-verified.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  list(): Promise<string>; // JSON rows: id, name, purpose, detail, kind, required, installed, needsSubscription, sizeBytes, unsupportedReason (string | null)
  deviceFit(): Promise<string>; // JSON { cpuReason: string | null, freeBytes: number } — the phone itself, before any download
  download(modelId: string): Promise<void>; // emits 'onModelProgress' events
  remove(modelId: string): Promise<void>;
  verify(modelId: string): Promise<boolean>; // sha256 check
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('ModelManager');
