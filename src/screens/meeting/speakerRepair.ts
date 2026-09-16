/**
 * Which lines a "who said this" change reaches, and what a new voice is called.
 *
 * A turn is consecutive same-speaker lines. Changing the speaker from a line onward splits the
 * turn there; changing a whole turn to its neighbour's speaker merges the two. Neither needs a
 * data shape of its own — only these ids.
 */
export type Scope = 'line' | 'rest' | 'turn';

export function linesForScope(
  turn: { parts: { id: string }[] },
  lineId: string,
  scope: Scope,
): string[] {
  const at = turn.parts.findIndex(p => p.id === lineId);
  if (at < 0) return [];
  switch (scope) {
    case 'line':
      return [lineId];
    case 'rest':
      return turn.parts.slice(at).map(p => p.id);
    case 'turn':
      return turn.parts.map(p => p.id);
  }
}

/** "Speaker N" for N one past the highest machine-style name in the meeting. */
export function nextSpeakerName(existing: string[]): string {
  let max = 0;
  for (const name of existing) {
    const m = /^Speaker ([1-9][0-9]*)$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Speaker ${max + 1}`;
}
