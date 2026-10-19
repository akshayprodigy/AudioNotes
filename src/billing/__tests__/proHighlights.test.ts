import { proHighlights } from '../proHighlights';

describe('proHighlights', () => {
  it('leads with meetings, then the writer, then export', () => {
    expect(proHighlights(undefined, true).map(h => h.key)).toEqual(['meetings', 'writer', 'export']);
  });

  it('swaps the writer for search by meaning on a phone that cannot run it', () => {
    const list = proHighlights(undefined, false);
    expect(list.map(h => h.key)).toEqual(['meetings', 'meaning', 'export']);
    for (const h of list) expect(h.text).not.toMatch(/written|minutes/i);
  });

  it('puts export first when the export gate sent the buyer', () => {
    expect(proHighlights('export', true).map(h => h.key)).toEqual(['export', 'meetings', 'writer']);
  });

  it('treats onboarding like no origin', () => {
    expect(proHighlights('onboarding', true)).toEqual(proHighlights(undefined, true));
  });
});
