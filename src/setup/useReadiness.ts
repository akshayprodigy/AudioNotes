import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import ModelManager from '../native/NativeModelManager';
import { useDownloadStore, runDownloads } from './essentialDownload';
import { essentialRows, readiness, type Readiness, type SetupRow } from './readiness';
import type { DeviceFit } from '../screens/deviceFit';

/** What a screen showing the readiness card needs: the state, the phone's fit, and the one action. */
export type Setup = {
  rows: SetupRow[];
  fit: DeviceFit | null;
  state: Readiness;
  /** Start or resume the essential download. The same call whether it is a first try, a resume or a retry. */
  start: () => Promise<boolean>;
  reload: () => void;
};

/**
 * First-run setup as the Library and Record screens read it. Reads the catalog on mount, when the
 * app returns to the foreground, and when a download run ends; the screen calls `reload` when it
 * regains focus. So a card that says "paused" is true of the disk and not of a minute ago.
 */
export function useSetupReadiness(): Setup {
  const [rows, setRows] = useState<SetupRow[]>([]);
  const [fit, setFit] = useState<DeviceFit | null>(null);
  const run = useDownloadStore();

  const reload = useCallback(() => {
    ModelManager.list()
      .then(r => setRows(essentialRows(JSON.parse(r) as SetupRow[])))
      .catch(() => {});
    Promise.resolve()
      .then(() => ModelManager.deviceFit())
      .then(r => setFit(JSON.parse(r)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    reload();
    const sub = AppState.addEventListener('change', a => {
      if (a === 'active') reload();
    });
    return () => sub.remove();
  }, [reload]);

  // A run that just ended changed the disk.
  useEffect(() => {
    if (!run.running) reload();
  }, [run.running, reload]);

  const start = useCallback(() => runDownloads(rows.filter(r => !r.installed)), [rows]);

  return {
    rows,
    fit,
    state: readiness(rows, { running: run.running, failed: run.failed, live: run.live }),
    start,
    reload,
  };
}
