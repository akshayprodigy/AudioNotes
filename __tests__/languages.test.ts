import {
  FALLBACK_LANGUAGES,
  orderLanguages,
  PINNED_LANGUAGES,
} from '../src/screens/languages';

/**
 * The picker shows what the native table offers, and nothing else.
 *
 * These tests used to assert the opposite — that every language whisper knows survives into the
 * list, so "a German or Spanish user must be able to pick their own language". That requirement is
 * gone. Offering a language the product cannot transcribe produced an hour-long Bengali meeting
 * rendered as fluent invented English, summarised into minutes that read as correct. See
 * docs/superpowers/specs/2026-09-04-english-only-and-refusing-to-fabricate-design.md.
 *
 * orderLanguages stays generic list logic, because languages come back one at a time and it will
 * have more than one row to sort again.
 */
describe('orderLanguages', () => {
  const engineList = [
    { code: 'zh', label: 'Chinese' },
    { code: 'en', label: 'English' },
    { code: 'de', label: 'German' },
    { code: 'ar', label: 'Arabic' },
  ];

  it('puts the pinned languages first, in their pinned order', () => {
    const got = orderLanguages(engineList).map(l => l.code);
    expect(got[0]).toBe('en');
  });

  it('sorts everything else alphabetically by label', () => {
    const got = orderLanguages(engineList).map(l => l.label);
    expect(got.slice(1)).toEqual(['Arabic', 'Chinese', 'German']);
  });

  it('passes through exactly what it was given', () => {
    // Ordering is presentation. What may be OFFERED is decided in cpp/asr/asr_languages.cpp, and
    // this function must not quietly add or drop a row on top of that decision.
    expect(orderLanguages(engineList)).toHaveLength(engineList.length);
  });

  it('does not invent a pinned language the engine did not offer', () => {
    const noEnglish = engineList.filter(l => l.code !== 'en');
    const got = orderLanguages(noEnglish).map(l => l.code);
    expect(got).not.toContain('en');
  });

  it('handles an empty list without throwing', () => {
    expect(orderLanguages([])).toEqual([]);
  });
});

describe('the offered languages', () => {
  it('is English and nothing else', () => {
    // The invariant this release exists to establish. A row is added here only alongside a row in
    // cpp/asr/asr_languages.cpp and the eval number that justifies it.
    expect(FALLBACK_LANGUAGES.map(l => l.code)).toEqual(['en']);
    expect(PINNED_LANGUAGES).toEqual(['en']);
  });

  it('does not offer auto-detect as a choice', () => {
    // Detection still runs — it is how an unsupported recording gets refused instead of
    // transcribed into nonsense — but with one supported language there is nothing to choose,
    // and "auto" would promise a capability this build does not have.
    expect(FALLBACK_LANGUAGES.some(l => l.code === 'auto')).toBe(false);
    expect(PINNED_LANGUAGES).not.toContain('auto');
  });

  it('offers no language the product has never measured', () => {
    // Named explicitly because these are the ones that were offered and failed: Bengali produced
    // 0.0% Bengali script from both whisper models, and Hindi has script evidence but no WER.
    for (const unmeasured of ['bn', 'hi', 'de', 'es', 'fr', 'zh', 'ar']) {
      expect(FALLBACK_LANGUAGES.some(l => l.code === unmeasured)).toBe(false);
    }
  });
});
