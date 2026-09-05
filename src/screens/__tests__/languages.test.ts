import { forceTranscribePrompt, forcedTranscriptNote } from '../languages';

/**
 * The copy that carries a forced transcript.
 *
 * Pinned as tests because these two strings are the entire safety mechanism of the override. The
 * refusal exists because fluent invented English over foreign audio is indistinguishable from a
 * real transcript; letting somebody overrule it is only safe while both halves of the trade are
 * stated up front and the result keeps saying what it is.
 */
describe('overruling a refusal', () => {
  it('states both outcomes, not just the one the user wants', () => {
    const p = forceTranscribePrompt('tr');
    expect(p.title).toBe('Transcribe it anyway?');
    expect(p.body).toContain('sounds like Turkish');
    expect(p.body).toContain('transcribe it as English');
    // The half people skip is the half that matters.
    expect(p.body).toContain('invented text that reads as real');
  });

  it('still warns when detection never named a language', () => {
    const p = forceTranscribePrompt(null);
    expect(p.body).toContain('does not sound like English');
    expect(p.body).toContain('invented text that reads as real');
  });

  it('names the heard language in the banner', () => {
    expect(forcedTranscriptNote('tr')).toBe(
      'Forced transcript — heard as Turkish, transcribed as English. ' +
        'If it was not English, the words below are invented.',
    );
  });

  it('warns in the banner even with no named language', () => {
    expect(forcedTranscriptNote(null)).toContain('did not sound like English');
    expect(forcedTranscriptNote(null)).toContain('invented');
  });

  /**
   * The two sides of the boundary must agree word for word. FileExportModule.forcedMarker builds
   * the same sentence in Kotlin for the exported file; if these drift, the same meeting says two
   * different things depending on where it is read.
   */
  it('matches the wording the Kotlin exporter uses', () => {
    expect(forcedTranscriptNote('tr')).toBe(
      'Forced transcript — heard as Turkish, transcribed as English. ' +
        'If it was not English, the words below are invented.',
    );
    expect(forcedTranscriptNote(undefined)).toBe(
      'Forced transcript — this did not sound like English, and was transcribed as English ' +
        'anyway. If it was not English, the words below are invented.',
    );
  });
});
