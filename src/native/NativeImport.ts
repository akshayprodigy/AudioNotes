// TurboModule spec for bringing in audio that was recorded somewhere else.
//
// The pipeline needs exactly one thing a shared file does not have: to be 16 kHz mono PCM16 on
// disk, which is what RecordingService writes and what every stage downstream assumes. Native
// decodes and resamples it (AudioImport + Resampler), after which the meeting is indistinguishable
// from one this app recorded — same VAD, same whisper, same minutes, same playback arithmetic.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // Open the system file picker and import what comes back. Resolves the new meeting's id, or
  // null when the picker was dismissed — a cancelled pick is a decision, not a failure.
  pick(): Promise<string | null>;

  // Import a URI we were handed. Resolves the new meeting's id.
  importUri(uri: string): Promise<string>;

  // The file another app shared while we were not running, exactly once. Mirrors
  // AudioPipeline.consumePendingMeetingId — MainActivity stashes it before React exists.
  //
  // A warm share (the app already open) arrives as the 'onSharedAudio' device event instead.
  consumePendingImport(): Promise<{ uri: string; name: string | null } | null>;

  // 'onImportProgress' { doneMs, totalMs }. totalMs is 0 when the container did not declare a
  // duration, which is normal for a streamed voice note.
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Import');
