import { create } from 'zustand';
import { PipelineController } from '../pipeline/PipelineController';

interface RecordingState {
  sessionId: string | null;
  isRecording: boolean;
  elapsedMs: number;
  start: (language: string | null) => Promise<void>;
  stop: () => Promise<string | null>; // returns sessionId that was captured
  tick: (ms: number) => void;
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  sessionId: null,
  isRecording: false,
  elapsedMs: 0,
  start: async language => {
    const sessionId = await PipelineController.startRecording(language);
    set({ sessionId, isRecording: true, elapsedMs: 0 });
  },
  stop: async () => {
    const { sessionId } = get();
    if (!sessionId) return null;
    await PipelineController.stopRecording(sessionId);
    set({ isRecording: false });
    return sessionId;
  },
  tick: ms => set({ elapsedMs: ms }),
}));
