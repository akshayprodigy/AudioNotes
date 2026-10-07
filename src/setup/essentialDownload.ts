import { NativeEventEmitter, NativeModules } from 'react-native';
import { create } from 'zustand';
import ModelManager from '../native/NativeModelManager';
import AudioPipeline from '../native/NativeAudioPipeline';

/**
 * The model download as ONE thing the whole app can see.
 *
 * Onboarding used to own the loop in its own component state, so the moment the person left that
 * screen (skipped, backgrounded, or the process died) the download vanished from the app: nothing
 * could say it was running, stopped or failed, and nothing could resume it. This is the loop and
 * its state, held outside any screen. Onboarding, the Library's readiness card and the Record
 * screen all read the same store and start the same run, and a second tap while one is going joins
 * it rather than starting a second.
 *
 * Resume is native: ModelManager.download() resumes a model's `.part` file with a Range request
 * and skips anything already installed, so "Resume" and "Retry" are the same call. Nothing here
 * restarts a download from the beginning.
 */
export type RunRow = { id: string; purpose: string; required: boolean };

type State = {
  running: boolean;
  /** The last run stopped on a required model. Cleared when a new run starts. */
  failed: boolean;
  /** Which model it stopped on, and the purpose to name it by. */
  failedPurpose: string;
  /** The model in flight, the position in the queue, and its length. */
  current: string;
  step: number;
  of: number;
  /** Live bytes of the model in flight; null between models. */
  live: { id: string; downloaded: number; total: number } | null;
};

const IDLE: State = { running: false, failed: false, failedPurpose: '', current: '', step: 0, of: 0, live: null };

export const useDownloadStore = create<State>(() => IDLE);

let inFlight: Promise<boolean> | null = null;
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  new NativeEventEmitter(NativeModules.ModelManager).addListener(
    'onModelProgress',
    (e: { id?: string; total: number; downloaded: number }) => {
      if (!(e.total > 0) || !useDownloadStore.getState().running) return;
      const id = e.id ?? useDownloadStore.getState().live?.id ?? '';
      useDownloadStore.setState({ live: { id, downloaded: e.downloaded, total: e.total } });
    },
  );
}

/** Test seam: forget everything, including a run that never settled. */
export function resetDownloadsForTest() {
  inFlight = null;
  useDownloadStore.setState(IDLE);
}

/**
 * Fetch these models in order. Resolves true when every REQUIRED one is on the phone.
 *
 * Only a required model can fail the run. Losing an optional one (the Pro writer) costs prose
 * minutes, not a working app, and it can be fetched later from Settings; failing the whole first
 * run over it would be a lie about how badly it went.
 */
export function runDownloads(queue: RunRow[]): Promise<boolean> {
  if (inFlight) return inFlight;
  listen();
  useDownloadStore.setState({ ...IDLE, running: true, of: queue.length });
  // The battery exemption is what lets a long download survive the screen going off.
  AudioPipeline.requestBatteryExemption().catch(() => {});

  inFlight = (async () => {
    try {
      for (let i = 0; i < queue.length; i++) {
        useDownloadStore.setState({ step: i, current: queue[i].purpose, live: null });
        try {
          await ModelManager.download(queue[i].id);
        } catch {
          if (queue[i].required) {
            useDownloadStore.setState({ running: false, failed: true, failedPurpose: queue[i].purpose, live: null });
            return false;
          }
        }
      }
      useDownloadStore.setState({ ...IDLE });
      return true;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
