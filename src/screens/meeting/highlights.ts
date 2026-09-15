import type { Utterance } from '../../pipeline/types';

/** A moment tapped while recording, on the capture clock. */
export interface Mark {
  id: number;
  atMs: number;
}

export interface Highlight {
  id: number;
  atMs: number;
  /** The sentence said at (or just after) the mark; null when nothing was said near it. */
  text: string | null;
  /**
   * Where the provenance button lands: the utterance's start when there is one, the mark itself
   * when there is not — so a mark with no words still plays the moment it was made.
   */
  anchorStartMs: number;
}

/** How far ahead a mark may reach for the next words. A mark is usually a beat BEFORE the thing. */
export const GAP_MS = 15_000;

/**
 * Resolve marks to what was said.
 *
 * Pure, and the only place the rule lives on the JS side; FileExportModule.highlightsFor mirrors
 * it for the exported document and ExportItemsTest replays this file's fixture against it. Marks
 * are keyed on time so this runs at render time — after a reprocess, the words may differ, the
 * moment does not.
 */
export function highlightsFor(marks: Mark[], utterances: Utterance[]): Highlight[] {
  const sorted = [...marks].sort((a, b) => a.atMs - b.atMs || a.id - b.id);
  const utts = [...utterances].sort((a, b) => a.startMs - b.startMs);
  return sorted.map(m => {
    const inside = utts.find(u => u.startMs <= m.atMs && m.atMs <= u.endMs);
    const hit = inside ?? utts.find(u => u.startMs > m.atMs && u.startMs - m.atMs <= GAP_MS);
    return hit
      ? { id: m.id, atMs: m.atMs, text: hit.text.trim(), anchorStartMs: hit.startMs }
      : { id: m.id, atMs: m.atMs, text: null, anchorStartMs: m.atMs };
  });
}
