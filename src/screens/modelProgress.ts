/**
 * Download progress as the Settings model rows hold it, and when to let go of it.
 *
 * Native emits `onModelProgress` for any download, from any screen, and a final (size, size) once
 * the model is in place — there is no separate completion event. Settings only ever cleared its
 * entry from its own Get button, so a download started on the Paywall or in Onboarding left the
 * row at "1.1 GB of 1.1 GB · 100%" with a spinner (D09).
 */
export type ProgressMap = Record<string, { downloaded: number; total: number }>;

/** The final event of a download: every byte accounted for. */
export function isDownloadComplete(downloaded: number, total: number): boolean {
  return total > 0 && downloaded >= total;
}

/** `progress` without the entries for models that are now installed — their rows are done. */
export function dropInstalled(progress: ProgressMap, models: { id: string; installed: boolean }[]): ProgressMap {
  const done = new Set(models.filter(m => m.installed).map(m => m.id));
  const ids = Object.keys(progress);
  if (!ids.some(id => done.has(id))) return progress;
  const next: ProgressMap = {};
  for (const id of ids) if (!done.has(id)) next[id] = progress[id];
  return next;
}
