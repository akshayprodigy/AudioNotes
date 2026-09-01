import {
  FALLBACK_LANGUAGES,
  orderLanguages,
  PINNED_LANGUAGES,
} from '../src/screens/languages';

describe('orderLanguages', () => {
  const engineList = [
    { code: 'zh', label: 'Chinese' },
    { code: 'en', label: 'English' },
    { code: 'de', label: 'German' },
    { code: 'hi', label: 'Hindi' },
    { code: 'auto', label: 'Auto-detect' },
    { code: 'ar', label: 'Arabic' },
  ];

  it('puts the pinned languages first, in their pinned order', () => {
    const got = orderLanguages(engineList).map(l => l.code);
    expect(got.slice(0, 3)).toEqual(['en', 'hi', 'auto']);
  });

  it('sorts everything else alphabetically by label', () => {
    const got = orderLanguages(engineList).map(l => l.label);
    expect(got.slice(3)).toEqual(['Arabic', 'Chinese', 'German']);
  });

  it('keeps every language the engine offered', () => {
    // The whole point of this release: a German or Spanish user must be able to pick their own
    // language. Dropping one silently is the failure being fixed.
    expect(orderLanguages(engineList)).toHaveLength(engineList.length);
  });

  it('does not invent a pinned language the engine did not offer', () => {
    const noHindi = engineList.filter(l => l.code !== 'hi');
    const got = orderLanguages(noHindi).map(l => l.code);
    expect(got).not.toContain('hi');
    expect(got.slice(0, 2)).toEqual(['en', 'auto']);
  });

  it('handles an empty list without throwing', () => {
    expect(orderLanguages([])).toEqual([]);
  });

  it('ships a fallback that still contains English', () => {
    // If the native call fails the picker falls back to this; it must remain usable.
    expect(FALLBACK_LANGUAGES.some(l => l.code === 'en')).toBe(true);
    expect(PINNED_LANGUAGES[0]).toBe('en');
  });
});
