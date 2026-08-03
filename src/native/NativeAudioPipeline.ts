// TurboModule spec — the SINGLE seam between JS and the native C++ inference core.
// Audio and inference never cross this boundary; only commands and small results/events do.
// Codegen reads this file (filename must start with `Native`). Implement it per platform.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // Start capture in the foreground service. Returns a sessionId.
  start(config: { sampleRate: number; language: string | null }): Promise<string>;
  // Stop capture; the meeting row is left in status 'captured'.
  stop(sessionId: string): Promise<void>;

  // Run the offline pipeline (vad -> asr -> diarize -> align -> structure) for a meeting.
  // `useLLM` gates the on-device Qwen step; false falls back to the rule-based floor.
  process(meetingId: string, options: { model: 'base' | 'small'; useLLM: boolean }): Promise<void>;
  cancel(meetingId: string): void;

  // Promote meetings stranded in 'recording' (process killed mid-capture) to 'captured'.
  // Returns how many were recovered. Safe to call at any time; skips a live recording.
  recoverOrphans(): Promise<number>;

  // Live capture state owned by native. Capture can be started by the floating bubble or outlive
  // the JS context, so the store must re-read this on resume rather than trust its own flag.
  currentSession(): Promise<{
    isRecording: boolean;
    meetingId: string | null;
    elapsedMs: number;
    silenced: boolean;
  }>;

  // Ask the OS to exempt the app from battery optimization (keeps long background recordings alive).
  requestBatteryExemption(): Promise<boolean>;

  // Progress + result events (payloads are small JSON strings).
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('AudioPipeline');
