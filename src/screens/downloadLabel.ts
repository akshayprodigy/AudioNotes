/**
 * How a download in progress describes itself.
 *
 * A percentage alone is the wrong unit for a large file. The writer model is about 1.1 GB, so a
 * percentage advances roughly once every ten seconds on a normal connection, and a number that
 * does not move is indistinguishable from one that is stuck — which is when people force-quit an
 * app that was working perfectly well.
 *
 * The bytes were always there: ModelManagerModule.emitProgress sends `downloaded` and `total`, and
 * every screen threw both away to keep a percentage. Showing the megabytes gives the eye something
 * that visibly ticks between percentage points.
 */

/** Bytes as MB or GB, with the precision each deserves and no trailing noise. */
export function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / 1_000_000;
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  if (mb < 1000) return `${Math.round(mb)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

/**
 * "412 MB of 1.1 GB · 37%", or just the percentage when the total is not known yet.
 *
 * The total arrives with the first progress event, so the fallback covers the moment between a tap
 * and the first byte — the one place where "0%" on its own is the honest thing to show.
 */
export function downloadLabel(downloaded: number, total: number): string {
  if (!(total > 0)) return '0%';
  const pct = Math.min(100, Math.round((downloaded / total) * 100));
  return `${size(downloaded)} of ${size(total)} · ${pct}%`;
}

/** The bar's fill, clamped, because a resumed download can report more bytes than it expected. */
export function downloadPct(downloaded: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
}
