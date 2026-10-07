import { writerCheckKey, writerCheckLine } from '../writerCheck';

/**
 * F24: the line the Summary card shows when the writer's fact check removed sentences. The string
 * is written by FactGuard.Tally.encoded() in Kotlin ("<n>|<class,class>"); these pin the reading.
 */
describe('writerCheckLine', () => {
  test('says how many sentences went, in the words the founder specified', () => {
    expect(writerCheckLine('2|currency,tense')).toBe(
      "2 sentences removed because the transcript doesn't support them.",
    );
    expect(writerCheckLine('7|')).toBe("7 sentences removed because the transcript doesn't support them.");
  });

  test('one sentence is singular', () => {
    expect(writerCheckLine('1|date')).toBe("1 sentence removed because the transcript doesn't support it.");
  });

  test('a clean narration, a missing key and garbage all say nothing', () => {
    expect(writerCheckLine('0|')).toBeNull();
    expect(writerCheckLine(null)).toBeNull();
    expect(writerCheckLine(undefined)).toBeNull();
    expect(writerCheckLine('')).toBeNull();
    expect(writerCheckLine('lots|number')).toBeNull();
    expect(writerCheckLine('-3|number')).toBeNull();
  });

  test('the key is per meeting and matches Narrator.kt (FactGuard.settingKey)', () => {
    expect(writerCheckKey('m1')).toBe('writer_check:m1');
    expect(writerCheckKey('m1')).not.toBe(writerCheckKey('m2'));
  });
});
