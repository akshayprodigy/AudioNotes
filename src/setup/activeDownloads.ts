import { NativeEventEmitter, NativeModules } from 'react-native';
import { create } from 'zustand';
import ModelManager from '../native/NativeModelManager';

/**
 * Every model download in flight, from any screen, as one store the Library draws (founder,
 * 22 Oct: whatever is downloading or updating belongs on the front page, not only in Settings).
 * Native sends onModelProgress every 512 KB for whoever started the download (setup, the Pro run,
 * anything else), so listening here sees all of them without any of them knowing about it.
 */
export type Live = { id: string; purpose: string; required: boolean; downloaded: number; total: number; at: number };

type State = { live: Record<string, Live> };

export const useActiveDownloads = create<State>(() => ({ live: {} }));

/** Quiet this long and it has stopped; whoever started it says why (setup card, Pro card). */
export const STALE_MS = 60_000;

let rows: Record<string, { purpose: string; required: boolean }> = {};
let listening = false;

async function loadRows() {
  try {
    const all: { id: string; purpose: string; required: boolean }[] = JSON.parse(await ModelManager.list());
    rows = Object.fromEntries(all.map(m => [m.id, { purpose: m.purpose, required: m.required }]));
  } catch {
    // Keep what we had: a purpose-less row still shows its bytes.
  }
}

/** Test seam. */
export function resetActiveDownloadsForTest() {
  rows = {};
  useActiveDownloads.setState({ live: {} });
}

/** Start listening, once per app process. `now` is a test seam. */
export function watchDownloads(now: () => number = Date.now) {
  loadRows();
  if (listening) return;
  listening = true;
  new NativeEventEmitter(NativeModules.ModelManager).addListener(
    'onModelProgress',
    (e: { id?: string; downloaded: number; total: number }) => {
      const id = e.id;
      if (!id || !(e.total > 0)) return;
      if (e.downloaded >= e.total) {
        useActiveDownloads.setState(s => {
          const { [id]: _done, ...rest } = s.live;
          return { live: rest };
        });
        return;
      }
      const known = rows[id];
      useActiveDownloads.setState(s => ({
        live: {
          ...s.live,
          [id]: { id, purpose: known?.purpose ?? '', required: known?.required ?? false, downloaded: e.downloaded, total: e.total, at: now() },
        },
      }));
      if (!known) {
        // A model this process has not listed yet: fill in its purpose, if it is still in flight.
        loadRows().then(() => {
          const r = rows[id];
          if (!r) return;
          useActiveDownloads.setState(s => (s.live[id] ? { live: { ...s.live, [id]: { ...s.live[id], ...r } } } : s));
        });
      }
    },
  );
}

/**
 * What the Library shows: everything in flight except the required models (the setup card already
 * shows those, with its own Retry), and nothing that has gone quiet.
 */
export function shownDownloads(live: Record<string, Live>, now: number): Live[] {
  return Object.values(live)
    .filter(d => !d.required && now - d.at < STALE_MS)
    .sort((a, b) => a.id.localeCompare(b.id));
}
