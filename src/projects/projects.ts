/**
 * "Add to project", as pure rules. A project is the app's thread: the meetings that share one
 * tag. Nothing here stores anything new - a project exists exactly when a meeting carries its tag,
 * and creating one is applying a tag nobody has used yet - so these functions only decide what the
 * sheet lists and what a typed name means.
 */

/** The one explanation, said once, in the words a person uses. */
export const PROJECT_EXPLAINER =
  'A project groups meetings so you can see decisions and open actions together.';

export const PROJECT_PRO_LINE = 'Projects are part of Pro';

export const PROJECT_FREE_NOTE =
  'You can still group meetings with a tag: use "Add a tag" in a meeting\'s menu.';

export interface ProjectChoice {
  name: string;
  /** Meetings already in it. */
  meetings: number;
  /** This meeting is already in it. */
  applied: boolean;
}

/** Existing projects, most-used first (the order `allTags` returns), marking the ones already applied. */
export function projectChoices(
  all: readonly { name: string; n: number }[],
  applied: readonly string[],
): ProjectChoice[] {
  const have = new Set(applied);
  return all.map(t => ({ name: t.name, meetings: t.n, applied: have.has(t.name) }));
}

/**
 * What the typed text will do. `name` is the normalised tag; `exists` says whether it is a project
 * already (so the button reads "Add to" rather than "Create"). Null when nothing usable was typed.
 */
export function resolveTyped(
  typed: string,
  all: readonly { name: string }[],
  normalise: (s: string) => string,
): { name: string; exists: boolean } | null {
  const name = normalise(typed);
  if (!name) return null;
  return { name, exists: all.some(t => t.name === name) };
}
