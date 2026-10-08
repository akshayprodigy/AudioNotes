import {
  ANNOUNCE_WINDOW_MS,
  DICTATION_TIP,
  RECORD_MODES,
  idleHint,
  modeLabel,
  recordModeOf,
  recordingHint,
} from '../recordMode';

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
    expect(idleHint('meeting', 3_600_000)).toBe('Tap to start recording · up to 1 hour on Free');
    expect(idleHint('meeting', 0)).toBe('Tap to start recording');
    expect(idleHint('dictation', 3_600_000)).toBe('Tap to dictate · up to 1 hour on Free');
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

describe('the hint while recording', () => {
  const base = { paused: false, mode: 'meeting' as const, announceOn: true, elapsedMs: 0 };

  it('asks a meeting to wait out the announcement, then goes back to listening', () => {
    expect(recordingHint(base)).toBe('Announcing the recording — start speaking after it');
    expect(recordingHint({ ...base, elapsedMs: ANNOUNCE_WINDOW_MS - 1 })).toBe(
      'Announcing the recording — start speaking after it',
    );
    expect(recordingHint({ ...base, elapsedMs: ANNOUNCE_WINDOW_MS })).toBe(
      'Listening — tap to finish',
    );
  });

  it('covers the whole clip: the window is longer than the 5.7 s the transcriber leaves out', () => {
    expect(ANNOUNCE_WINDOW_MS).toBeGreaterThan(5_700 + 300);
  });

  it('says nothing about an announcement that is not made', () => {
    expect(recordingHint({ ...base, mode: 'dictation' })).toBe('Listening — tap to finish');
    expect(recordingHint({ ...base, announceOn: false })).toBe('Listening — tap to finish');
  });

  it('a pause is still a pause', () => {
    expect(recordingHint({ ...base, paused: true })).toBe('Paused — tap resume to continue');
  });
});
