import { consentCardText, GDPR_REGIONS } from '../consent';

/**
 * The card is text, so it can vary by region at no cost. The SPOKEN clip cannot — it is one
 * bundled file, and shipping an audio asset per legal regime would be the jurisdiction map the
 * spec rejected, wearing a different hat.
 */
describe('the card the room is shown', () => {
  it('names the recording and its purpose in GDPR territories', () => {
    const t = consentCardText('DE');
    expect(t.title).toBe('This meeting is being recorded');
    expect(t.body).toContain('stays on this phone');
    expect(t.body).toContain('written up into notes');
  });

  it('uses plain disclosure everywhere else', () => {
    const t = consentCardText('US');
    expect(t.title).toBe('This meeting is being recorded');
    expect(t.body).toContain('stays on this phone');
    expect(t.body).not.toContain('written up into notes');
  });

  it('falls back to the plain wording for a region it does not know', () => {
    // Says less, not more, which is safe in every jurisdiction.
    expect(consentCardText(null).body).toBe(consentCardText('US').body);
    expect(consentCardText('ZZ').body).toBe(consentCardText('US').body);
    expect(consentCardText('').body).toBe(consentCardText('US').body);
  });

  it('is case-insensitive about the region code', () => {
    expect(consentCardText('de').body).toBe(consentCardText('DE').body);
  });

  it('never tells anybody they are compliant', () => {
    // The app reports what it did, never what that means legally. A confident wrong jurisdiction
    // call is worse than none, and this ships into dozens of legal regimes.
    for (const region of [...GDPR_REGIONS, 'US', 'IN', null]) {
      const t = consentCardText(region);
      const all = `${t.title} ${t.body}`.toLowerCase();
      expect(all).not.toContain('legal');
      expect(all).not.toContain('complian');
      expect(all).not.toContain('consent is required');
    }
  });
});
