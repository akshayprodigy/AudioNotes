/**
 * The language list the transcriber offers, and the order it is offered in.
 *
 * Separate from SettingsScreen so it can be tested without mounting a screen: this is pure list
 * logic, and the thing most likely to break it is a well-meant sort.
 */
export type LanguageChoice = { code: string; label: string };

/**
 * Shown only until the engine answers, and if it never does.
 *
 * These three were the WHOLE list until now, which is an India-only menu in a product launching
 * in the US and Europe — a German user could not select German, so the app could not capture
 * their meeting at all. The real list comes from the transcriber itself (~99 languages), because
 * a hand-maintained copy drifts from what the model can actually do.
 */
export const FALLBACK_LANGUAGES: LanguageChoice[] = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
];

/**
 * Pinned to the top of the picker. A 99-item list in raw engine order is unusable, and these are
 * the ones the product is measured on. 'auto' stays reachable but is last of the three and is no
 * longer the default, because per-chunk re-detection is the bug this release fixes.
 */
export const PINNED_LANGUAGES = ['en', 'hi', 'auto'];

/** Pinned codes first in their listed order, then everything else alphabetically by label. */
export function orderLanguages(all: LanguageChoice[]): LanguageChoice[] {
  const byCode = new Map(all.map(l => [l.code, l]));
  const pinned = PINNED_LANGUAGES.map(c => byCode.get(c)).filter(
    (l): l is LanguageChoice => l !== undefined,
  );
  const rest = all
    .filter(l => !PINNED_LANGUAGES.includes(l.code))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...pinned, ...rest];
}
