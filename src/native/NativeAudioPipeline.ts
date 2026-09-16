// TurboModule spec — the SINGLE seam between JS and the native C++ inference core.
// Audio and inference never cross this boundary; only commands and small results/events do.
// Codegen reads this file (filename must start with `Native`). Implement it per platform.
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // Start capture in the foreground service. Returns a sessionId.
  /**
   * `capMs` is the free tier's length limit in milliseconds; 0 or omitted means uncapped.
   *
   * Passed in rather than derived natively because entitlement is a JavaScript concept, and
   * enforced natively because the recording outlives the UI — screen off, app killed, service
   * still running. A limit that lived only here would not survive the case it exists for.
   */
  start(config: {
    sampleRate: number;
    language: string | null;
    tier?: string;
    capMs?: number;
  }): Promise<string>;
  // Stop capture; the meeting row is left in status 'captured'.
  stop(sessionId: string): Promise<void>;

  // Every language the transcriber can be pinned to, as JSON [{code,label}].
  //
  // Read from the engine rather than listed in the UI, because a hand-maintained shortlist drifts
  // from what the model can actually do — and this app ships in India, the US and Europe.
  supportedLanguages(): Promise<string>;

  // Run the offline pipeline (vad -> asr -> diarize -> align -> structure) for a meeting.
  // Narration is a native pipeline stage now, so there is no flag for it here: it runs whenever
  // the model is installed, the device is capable, and the transcript is long enough to summarise
  // without inventing (see Narrator).
  //
  // `force` makes narration outstanding again WITHOUT deleting what is already written. The
  // screen used to clear the prose first so the resume plan would see work to do — which meant a
  // rewrite that could not run (no entitlement, no model, an out-of-memory kill) destroyed the
  // summary it was supposed to replace. Narrator's own write is source-scoped and overwrites
  // atomically, so nothing needs deleting up front.
  process(meetingId: string, options: { model: 'base' | 'small'; force?: boolean }): Promise<void>;
  cancel(meetingId: string): void;

  // Promote meetings stranded in 'recording' (process killed mid-capture) to 'captured'.
  // Returns how many were recovered. Safe to call at any time; skips a live recording.
  recoverOrphans(): Promise<number>;

  // Delete a meeting's raw PCM once transcribed (BUILD_PLAN 4.7 retention promise).
  // Returns bytes reclaimed. The transcript and minutes live on in the encrypted DB.
  discardAudio(meetingId: string): Promise<number>;

  // Consume (and clear) a meetingId stashed by a cold-start "Notes ready" notification tap, so the
  // navigator can deep-link to it on mount. Resolves null when there is none. Warm taps arrive as
  // the 'onOpenMeeting' DeviceEventEmitter event instead.
  consumePendingMeetingId(): Promise<string | null>;

  // Live capture state owned by native. Capture can be started by the floating bubble or outlive
  // the JS context, so the store must re-read this on resume rather than trust its own flag.
  currentSession(): Promise<{
    isRecording: boolean;
    meetingId: string | null;
    elapsedMs: number;
    silenced: boolean;
    paused: boolean;
  }>;

  // Pause/resume without ending the meeting. Native owns the flag because capture outlives the
  // JS context — a JS-held pause would silently resume on reload and record what the user thought
  // was private. `elapsedMs` excludes paused time so the timer matches the audio on disk.
  setPaused(paused: boolean): Promise<boolean>;

  // Mark this moment on the capture clock. Null when nothing is recording. The same call the
  // PiP window and the notification make; all three land in CaptureController.mark.
  mark(): Promise<number | null>;
  // Events (DeviceEventEmitter): onCaptureLevel {level}, onCaptureState, onCaptureMark {atMs},
  // onCaptureWarning {kind: 'loud'|'faint'|'storage'|null, minutesLeft}.
  // Processing: onStageProgress {meetingId, stage, chunk, total}, onStageComplete, onError,
  // onProcessingPause {meetingId, reason: 'heat'|'battery'|null}.

  // Delete audio for meetings past the retention window (Settings > Keep the audio). Returns how
  // many were swept. Never touches a meeting without a transcript — the audio is the only copy of
  // a meeting that failed to transcribe — nor the one being recorded right now.
  sweepAudioRetention(): Promise<number>;

  // Ask the OS to exempt the app from battery optimization (keeps long background recordings alive).
  requestBatteryExemption(): Promise<boolean>;

  // Progress + result events (payloads are small JSON strings).
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('AudioPipeline');
