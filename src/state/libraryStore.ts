import { create } from 'zustand';
import { db } from '../db/queries';
import type { Meeting } from '../pipeline/types';

interface LibraryState {
  meetings: Meeting[];
  loading: boolean;
  refresh: () => Promise<void>;
}

export const useLibraryStore = create<LibraryState>(set => ({
  meetings: [],
  loading: false,
  refresh: async () => {
    set({ loading: true });
    try {
      const meetings = await db.listMeetings();
      set({ meetings, loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));
