/**
 * The language list the transcriber offers, and the order it is offered in.
 *
 * Separate from SettingsScreen so it can be tested without mounting a screen: this is pure list
 * logic, and the thing most likely to break it is a well-meant sort.
 */
export type LanguageChoice = { code: string; label: string };

/**
 * Shown only until the native side answers, and if it never does.
 *
 * One row, matching cpp/asr/asr_languages.cpp, which is the source of truth. This list was once
 * ~99 languages read out of whisper's tokenizer table; offering Bengali produced an hour-long
 * meeting transcribed as fluent invented English, with a summary that read as correct to somebody
 * who had been in the room. A language appears here when there is a measurement behind it.
 */
export const FALLBACK_LANGUAGES: LanguageChoice[] = [{ code: 'en', label: 'English' }];

/**
 * Pinned to the top of the picker.
 *
 * 'auto' is deliberately gone as well as the other languages: with one supported language there is
 * nothing to choose between, and "auto-detect" would promise a capability the build does not have.
 * Detection still runs — it is how an unsupported recording is refused instead of being
 * transcribed into nonsense — but it is not a setting anybody picks.
 */
export const PINNED_LANGUAGES = ['en'];

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

/**
 * The English name of a language code, or null if we cannot name it.
 *
 * Wrapped because Intl.DisplayNames is not guaranteed on every Hermes build, and a missing
 * formatter must not take down the screen that reports a refusal.
 */
export function languageName(code: string | null | undefined): string | null {
  if (!code) return null;
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'language' });
    const name = dn.of(code);
    // Intl returns the input unchanged for codes it does not know.
    return name && name.toLowerCase() !== code.toLowerCase() ? name : null;
  } catch {
    return null;
  }
}

/**
 * What to tell somebody whose recording was not transcribed.
 *
 * Composed here from the meeting's status and language rather than stored, because the stored
 * version lived in `summary_line` — the field that says what a meeting was ABOUT. A recording that
 * was refused and later transcribed successfully kept leading with "this sounds like Turkish",
 * since only narration overwrites that field and narration is Pro-only. A status message in a
 * content field outlives the status.
 */
export function unsupportedLanguageNote(code: string | null | undefined): string {
  const name = languageName(code);
  return name
    ? `This recording sounds like ${name}, and Verbale transcribes English today.`
    : 'This recording does not sound like English, and Verbale transcribes English today.';
}

/** The same fact, short enough for a library row. */
export function unsupportedLanguageShort(code: string | null | undefined): string {
  const name = languageName(code);
  return name ? `Not transcribed — sounds like ${name}.` : 'Not transcribed — not English.';
}

/**
 * What to ask before overruling a refusal.
 *
 * Both outcomes, in the order that decides the answer. A generic "are you sure" would get tapped
 * through: the person already believes the recording is English, so the only useful sentence is
 * the one describing what happens if they are wrong — fluent invented text that reads as real,
 * which is the failure the refusal exists to prevent.
 */
export function forceTranscribePrompt(code: string | null | undefined): {
  title: string;
  body: string;
} {
  const name = languageName(code);
  const heard = name ? `This sounds like ${name}.` : 'This does not sound like English.';
  return {
    title: 'Transcribe it anyway?',
    body:
      `${heard} If we heard wrong, this will transcribe it as English. ` +
      'If we heard right, the result will be invented text that reads as real.',
  };
}

/**
 * The banner a forced transcript carries for the rest of its life.
 *
 * Not dismissible where it is rendered, and composed here rather than stored, for the reason
 * unsupportedLanguageNote records: a status message parked in a content field outlives its status.
 * The person who forced it knew what they were doing; the person reading it three weeks later, or
 * the colleague they forwarded it to, did not.
 *
 * Kept word for word in step with FileExportModule.forcedMarker, which builds the same sentence in
 * Kotlin for the exported file. Both are pinned by tests, because the same meeting saying two
 * different things depending on where it is read would undo the point of saying it at all.
 */
export function forcedTranscriptNote(code: string | null | undefined): string {
  const name = languageName(code);
  return name
    ? `Forced transcript — heard as ${name}, transcribed as English. ` +
        'If it was not English, the words below are invented.'
    : 'Forced transcript — this did not sound like English, and was transcribed as English ' +
        'anyway. If it was not English, the words below are invented.';
}
