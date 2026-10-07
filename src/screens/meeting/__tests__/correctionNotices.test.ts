import {
  STALE_SUMMARY_COPY,
  droppedKey,
  droppedNotice,
  staleKey,
  takeDroppedNotice,
} from '../correctionNotices';

/** The keys are written natively (Corrections.kt, CorrectionsTest.theKeysArePerMeeting) and read here. */
it('spells the settings keys the way the native side writes them', () => {
  expect(staleKey('m1')).toBe('narration.stale.m1');
  expect(droppedKey('m1')).toBe('corrections.dropped.m1');
});

it('says what the stale summary needs, with the existing action named', () => {
  expect(STALE_SUMMARY_COPY).toBe(
    'You corrected the transcript after this summary was written. Write it again to update it.',
  );
});

it('words the dropped count the way the native twin does', () => {
  expect(droppedNotice(0)).toBeNull();
  expect(droppedNotice(1)).toBe("1 correction couldn't be re-applied");
  expect(droppedNotice(2)).toBe("2 corrections couldn't be re-applied");
});

describe('takeDroppedNotice', () => {
  const store = (initial: Record<string, string>) => {
    const m = new Map(Object.entries(initial));
    return {
      getSetting: jest.fn(async (k: string) => m.get(k) ?? null),
      setSetting: jest.fn(async (k: string, v: string) => void m.set(k, v)),
    };
  };

  it('is said once: reading it clears it', async () => {
    const s = store({ 'corrections.dropped.m1': '2' });
    expect(await takeDroppedNotice(s, 'm1')).toBe("2 corrections couldn't be re-applied");
    expect(s.setSetting).toHaveBeenCalledWith('corrections.dropped.m1', '0');
    expect(await takeDroppedNotice(s, 'm1')).toBeNull();
  });

  it('says nothing for a meeting that dropped nothing, and writes nothing', async () => {
    const s = store({});
    expect(await takeDroppedNotice(s, 'm1')).toBeNull();
    expect(s.setSetting).not.toHaveBeenCalled();
  });

  it("does not read another meeting's count", async () => {
    const s = store({ 'corrections.dropped.m2': '3' });
    expect(await takeDroppedNotice(s, 'm1')).toBeNull();
  });
});
