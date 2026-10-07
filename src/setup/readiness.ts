import { runnable, sizeMb } from '../screens/deviceFit';

/**
 * What first-run setup is, as one pure answer.
 *
 * The first download is the one thing standing between a new install and a working recorder, and
 * three screens need to speak about it honestly (onboarding, Library, Record): how much is fetched,
 * whether it is moving, whether it stopped. They all ask this, so they cannot disagree. No native
 * calls here; the catalog rows and the run's own state come in as arguments.
 *
 * ESSENTIAL means the models a recording cannot be made into notes without: the catalog's own
 * `required` flag (ModelCatalog), the same set onboarding has always downloaded. The Pro writer
 * and the larger transcriber are not in it, and neither is anything this phone cannot run.
 */
export type SetupRow = {
  id: string;
  purpose: string;
  kind: string;
  required: boolean;
  installed: boolean;
  sizeBytes: number;
  /** Bytes already on disk for a model not yet installed (a resumable .part). 0 or absent: none. */
  heldBytes?: number;
  unsupportedReason?: string | null;
};

/** The models first run must fetch on THIS phone. */
export function essentialRows<T extends SetupRow>(all: T[]): T[] {
  return runnable(all.filter(m => m.required));
}

/** Megabytes still to fetch for these rows — what the button quotes. Installed rows cost nothing. */
export function essentialSize(rows: SetupRow[]): number {
  return sizeMb(rows.filter(m => !m.installed));
}

/** What the download controller knows right now. `live` is the model in flight and its bytes so far. */
export type RunState = {
  running: boolean;
  failed: boolean;
  live: { id: string; downloaded: number } | null;
};

export type Readiness =
  | { state: 'unknown' }
  | { state: 'ready' }
  | {
      state: 'notStarted' | 'paused' | 'downloading' | 'failed';
      /** 0..99: a figure that has not finished never reads 100. */
      pct: number;
      totalMb: number;
      totalBytes: number;
      pendingBytes: number;
    };

export function readiness(rows: SetupRow[], run: RunState): Readiness {
  if (rows.length === 0) return { state: 'unknown' };
  if (rows.every(r => r.installed)) return { state: 'ready' };

  const totalBytes = rows.reduce((a, r) => a + r.sizeBytes, 0);
  let have = 0;
  for (const r of rows) {
    if (r.installed) {
      have += r.sizeBytes;
      continue;
    }
    let held = r.heldBytes ?? 0;
    // The model in flight: the live figure, but never below what the disk already said, so the
    // number cannot step backwards when a resumed part reports before its first event.
    if (run.running && run.live?.id === r.id) held = Math.max(held, run.live.downloaded);
    have += Math.min(held, r.sizeBytes);
  }
  const pct = Math.min(99, Math.max(0, Math.floor((have / totalBytes) * 100)));
  const pendingBytes = rows.filter(r => !r.installed).reduce((a, r) => a + r.sizeBytes, 0);
  const base = { pct, totalMb: sizeMb(rows), totalBytes, pendingBytes };

  if (run.running) return { state: 'downloading', ...base };
  if (run.failed) return { state: 'failed', ...base };
  return { state: have > 0 ? 'paused' : 'notStarted', ...base };
}

/** The card's words and its one action, or null when there is nothing to say. */
export function readinessCopy(r: Readiness): { title: string; action: string | null } | null {
  switch (r.state) {
    case 'unknown':
    case 'ready':
      return null;
    case 'notStarted':
      return { title: `Finish setup — ${r.totalMb} MB to download`, action: 'Download' };
    case 'paused':
      return { title: `Finish setup — ${r.pct}% of ${r.totalMb} MB downloaded`, action: 'Resume' };
    case 'downloading':
      return { title: `Downloading — ${r.pct}% of ${r.totalMb} MB`, action: null };
    case 'failed':
      return {
        title: `Setup stopped — ${r.pct}% of ${r.totalMb} MB downloaded. Check your connection.`,
        action: 'Retry',
      };
  }
}
