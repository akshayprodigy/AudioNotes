/**
 * Naming the language a recording was heard as, on a phone.
 *
 * These four strings degraded silently in production for a reason no unit test could see: the
 * implementation asked `Intl.DisplayNames`, Jest runs on Node with full ICU and answers, and
 * Hermes on the device does not. Every test passed while the app said "this recording does not
 * sound like English" about a German recording it had just identified as German — and the forced
 * transcript banner, which is the whole safety mechanism of the override, lost its claim.
 *
 * Observed on a Pixel 7 Pro on 6 September 2026: logcat recorded `heard 'de'`, and the screen
 * showed the no-language fallback.
 *
 * So the rule is: the names must not depend on Intl. These tests delete it to prove it.
 */
describe('naming a language without Intl', () => {
  const realIntl = globalThis.Intl;

  afterEach(() => {
    globalThis.Intl = realIntl;
  });

  function withoutIntl<T>(fn: () => T): T {
    // Hermes, as far as this code is concerned.
    globalThis.Intl = undefined as unknown as typeof Intl;
    return fn();
  }

  it('names the languages the detector can emit, with no Intl at all', () => {
    const { languageName } = require('../languages');
    withoutIntl(() => {
      expect(languageName('de')).toBe('German');
      expect(languageName('tr')).toBe('Turkish');
      expect(languageName('hi')).toBe('Hindi');
      expect(languageName('bn')).toBe('Bengali');
      expect(languageName('en')).toBe('English');
    });
  });

  it('still refuses to name something it does not know', () => {
    const { languageName } = require('../languages');
    withoutIntl(() => {
      expect(languageName('zzz')).toBeNull();
      expect(languageName('')).toBeNull();
      expect(languageName(null)).toBeNull();
    });
  });

  it('is case- and region-insensitive, because detectors are not consistent', () => {
    const { languageName } = require('../languages');
    withoutIntl(() => {
      expect(languageName('DE')).toBe('German');
      expect(languageName('de-DE')).toBe('German');
    });
  });

  /** The three strings that were quietly wrong on the device. */
  it('carries the name into the copy that keeps a forced transcript honest', () => {
    const {
      forcedTranscriptNote,
      unsupportedLanguageNote,
      forceTranscribePrompt,
    } = require('../languages');
    withoutIntl(() => {
      expect(forcedTranscriptNote('de')).toContain('heard as German');
      expect(unsupportedLanguageNote('de')).toContain('sounds like German');
      expect(forceTranscribePrompt('de').body).toContain('sounds like German');
    });
  });
});
