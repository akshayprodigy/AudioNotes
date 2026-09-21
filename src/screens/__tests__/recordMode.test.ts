import { DICTATION_TIP, RECORD_MODES, idleHint, modeLabel, recordModeOf } from '../recordMode';

describe('recordModeOf', () => {
  it('reads dictation, and meeting for everything else', () => {
    expect(recordModeOf('dictation')).toBe('dictation');
    expect(recordModeOf('meeting')).toBe('meeting');
    expect(recordModeOf(null)).toBe('meeting');
    expect(recordModeOf(undefined)).toBe('meeting');
    expect(recordModeOf('Dictation')).toBe('meeting');
  });
});

describe('the words', () => {
  it('offers the two modes in this order with these labels', () => {
    expect(RECORD_MODES).toEqual([
      { key: 'meeting', label: 'Meeting' },
      { key: 'dictation', label: 'Dictation' },
    ]);
    expect(modeLabel('meeting')).toBe('Meeting');
    expect(modeLabel('dictation')).toBe('Dictation');
  });

  it('keeps the free cap in the hint for both modes', () => {
    expect(idleHint('meeting', 900_000)).toBe('Tap to start recording · up to 15 min on Free');
    expect(idleHint('meeting', 0)).toBe('Tap to start recording');
    expect(idleHint('dictation', 900_000)).toBe('Tap to dictate · up to 15 min on Free');
    expect(idleHint('dictation', 0)).toBe('Tap to dictate');
  });

  it('names all five marks the C++ understands, and neither noun', () => {
    for (const m of ['full stop', 'comma', 'question mark', 'new line', 'new paragraph']) {
      expect(DICTATION_TIP).toContain(`“${m}”`);
    }
    expect(DICTATION_TIP).not.toContain('period');
    expect(DICTATION_TIP).not.toContain('colon');
  });
});
