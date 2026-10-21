import { NativeEventEmitter, NativeModules } from 'react-native';
import { create } from 'zustand';
import ModelManager from '../native/NativeModelManager';
import AudioPipeline from '../native/NativeAudioPipeline';
import { proToFetch } from '../billing/proDownload';
import { useDownloadStore } from './essentialDownload';

/**
 * Pro's models as ONE background download the whole app can see (founder, 21 Oct). It starts the
 * moment Pro is bought, keeps going while the person leaves the Pro screen and uses the app, and a
 * later launch picks up a run that stopped. Nobody has to visit Settings for it. A sibling of
 * essentialDownload, with the same shape on purpose: native resumes a `.part`, so "Try again" and
 * "carry on" are the same call.
 */
type State = {
  running: boolean;
  /** Why the last run stopped, in native's words; null when it did not fail. */
  error: string | null;
  /** Bytes of the whole run: the models finished plus the one in flight. */
  downloaded: number;
  total: number;
};

const IDLE: State = { running: false, error: null, downloaded: 0, total: 0 };

export const useProModelsStore = create<State>(() => IDLE);

let inFlight: Promise<boolean> | null = null;
let doneBytes = 0;
let listening = false;
let autoTried = false;

function listen() {
  if (listening) return;
  listening = true;
  new NativeEventEmitter(NativeModules.ModelManager).addListener(
    'onModelProgress',
    (e: { total: number; downloaded: number }) => {
      const st = useProModelsStore.getState();
      if (!(e.total > 0) || !st.running) return;
      useProModelsStore.setState({ downloaded: Math.min(st.total, doneBytes + e.downloaded) });
    },
  );
}

/** Test seam: forget everything, including a run that never settled. */
export function resetProModelsForTest() {
  inFlight = null;
  doneBytes = 0;
  autoTried = false;
  useProModelsStore.setState(IDLE);
}

/**
 * Fetch every Pro model this phone still needs, smallest first. Resolves true once all are here.
 * A second call while one runs joins it. It never runs beside first-run setup's download, because
 * two downloads of the same model would write the same `.part` file.
 */
export function runProModels(): Promise<boolean> {
  if (inFlight) return inFlight;
  if (useDownloadStore.getState().running) return Promise.resolve(false);
  listen();
  useProModelsStore.setState({ ...IDLE, running: true });

  inFlight = (async () => {
    try {
      const todo = proToFetch(JSON.parse(await ModelManager.list()));
      const total = todo.reduce((a, m) => a + m.sizeBytes, 0);
      doneBytes = 0;
      useProModelsStore.setState({ total, downloaded: 0 });
      // The exemption is what lets 1.3 GB survive the screen going off. Asked only when there is
      // something to fetch: a Pro phone with everything on it must not see the system dialog.
      if (todo.length > 0) AudioPipeline.requestBatteryExemption().catch(() => {});
      for (const m of todo) {
        await ModelManager.download(m.id);
        doneBytes += m.sizeBytes;
        useProModelsStore.setState({ downloaded: doneBytes });
      }
      useProModelsStore.setState(IDLE);
      return true;
    } catch (e: any) {
      useProModelsStore.setState({ running: false, error: String(e?.message ?? e) });
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * On a Pro phone, without being asked, once per app process: picks up a run that stopped (the app
 * was closed, the phone lost signal). Not while setup's own download runs; then the next launch
 * tries, because `autoTried` is set only when a run actually starts.
 */
export function autoStartProModels(paid: boolean): Promise<boolean> | null {
  if (!paid || autoTried || inFlight || useDownloadStore.getState().running) return null;
  autoTried = true;
  return runProModels();
}
