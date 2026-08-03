import { create } from 'zustand';
import { PipelineController } from '../pipeline/PipelineController';

interface RecordingState {
  sessionId: string | null;
  isRecording: boolean;
  elapsedMs: number;
  silenced: boolean;
  startedAt: number | null; // wall-clock ms, so the timer survives a trip to the background
  start: (language: string | null) => Promise<void>;
  stop: () => Promise<string | null>; // returns sessionId that was captured
  sync: () => Promise<void>;
  tick: (ms: number) => void;
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  sessionId: null,
  isRecording: false,
  elapsedMs: 0,
  silenced: false,
  startedAt: null,
  start: async language => {
    const sessionId = await PipelineController.startRecording(language);
    set({ sessionId, isRecording: true, elapsedMs: 0, startedAt: Date.now(), silenced: false });
  },
  stop: async () => {
    const { sessionId } = get();
    if (!sessionId) return null;
    await PipelineController.stopRecording(sessionId);
    set({ isRecording: false, startedAt: null, silenced: false });
    return sessionId;
  },

  /**
   * Re-read the live capture state from native.
   *
   * Native owns the truth: a meeting can be started from the floating bubble, and the JS context
   * can be torn down and rebuilt while capture keeps running inside the foreground service.
   * Without this the Record screen comes back showing 00:00 and an idle mic, and tapping it
   * starts a SECOND meeting on top of the one already running. Call on app resume.
   */
  sync: async () => {
    try {
      const s = await PipelineController.currentSession();
      set({
        isRecording: s.isRecording,
        sessionId: s.meetingId ?? null,
        silenced: s.silenced,
        elapsedMs: s.elapsedMs,
        // Anchor the local timer to native's elapsed time so the display stays correct.
        startedAt: s.isRecording ? Date.now() - s.elapsedMs : null,
      });
    } catch {
      // Native not ready yet (very early startup) — the next resume picks it up.
    }
  },
  tick: ms => set({ elapsedMs: ms }),
}));
