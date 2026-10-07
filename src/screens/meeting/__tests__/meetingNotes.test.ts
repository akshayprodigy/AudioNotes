import { announceLine, endingAckKey, endingCardNote, endingNote, holdFor } from '../meetingNotes';

describe('endingNote', () => {
  it('says nothing for a Stop, or for a meeting from before endings were kept', () => {
    expect(endingNote('stopped', 60_000)).toBeNull();
    expect(endingNote(null, 60_000)).toBeNull();
    expect(endingNote(undefined, 60_000)).toBeNull();
  });
  it('names the reason and says what was kept', () => {
    expect(endingNote('mic_lost', 60_000)).toBe(
      'Stopped early: a call or another app took the microphone. Everything up to that point is kept.',
    );
    expect(endingNote('cap_reached', 60_000)).toBe('Stopped at the Free limit. Everything up to that point is kept.');
  });
  it('says a forgotten pause ended the recording and that what was recorded is kept', () => {
    expect(endingNote('pause_timeout', 60_000)).toBe('Ended after an hour paused. Everything up to that point is kept.');
  });
  it('says nothing was recorded when nothing was', () => {
    expect(endingNote('mic_unavailable', 0)).toBe('The microphone could not be opened, so nothing was recorded.');
  });
});

describe('announceLine', () => {
  it('announced is said plainly, not as a warning', () => {
    expect(announceLine('played')).toEqual({ text: 'Announced at the start of the recording.', warn: false });
  });
  it('every other outcome is "not announced", with why', () => {
    expect(announceLine('silenced')).toEqual({ text: 'Not announced: the phone was on silent.', warn: true });
    expect(announceLine('not_heard')?.text).toBe('Not announced: the recording did not pick the announcement up.');
    expect(announceLine('disabled')?.text).toBe('Not announced: the announcement is switched off.');
    expect(announceLine('failed')?.text).toBe('Not announced: the announcement did not play.');
    expect(announceLine('no_clip')?.text).toBe('Not announced: the announcement did not play.');
  });
  it('a meeting from before outcomes were kept says nothing', () => {
    expect(announceLine(null)).toBeNull();
    expect(announceLine('something new')).toBeNull();
  });
});

describe('holdFor — what a meeting with nothing written is', () => {
  const m = (status: string, durationMs = 60_000) => ({ status, durationMs });
  it('queued, part-way, or waiting for its speech model is waiting — never silent', () => {
    for (const s of ['recording', 'captured', 'vad', 'asr', 'diarized']) expect(holdFor(m(s))).toBe('waiting');
    expect(holdFor(null)).toBe('waiting');
  });
  it('a crash is failed', () => expect(holdFor(m('failed'))).toBe('failed'));
  it('no speech needs audio; no audio is its own thing', () => {
    expect(holdFor(m('error'))).toBe('no-speech');
    expect(holdFor(m('error', 0))).toBe('no-audio');
  });
});

describe('endingCardNote', () => {
  const NOW = Date.UTC(2026, 9, 7, 12);
  const DAY = 24 * 60 * 60 * 1000;
  const m = (over: object = {}) => ({ createdAt: NOW - DAY, durationMs: 60_000, endReason: 'mic_lost', ...over });
  const o = (over: object = {}) => ({ acknowledged: false, paid: false, now: NOW, ...over });

  it('is the ending sentence for each reason the app can end a recording for', () => {
    for (const r of ['cap_reached', 'mic_lost', 'mic_unavailable', 'disk_full', 'write_failed', 'pause_timeout']) {
      expect(endingCardNote(m({ endReason: r }), o())).toBe(endingNote(r, 60_000));
      expect(endingCardNote(m({ endReason: r }), o())).not.toBeNull();
    }
  });
  it('says nothing for a Stop, an unknown reason, or no meeting', () => {
    expect(endingCardNote(m({ endReason: 'stopped' }), o())).toBeNull();
    expect(endingCardNote(m({ endReason: null }), o())).toBeNull();
    expect(endingCardNote(null, o())).toBeNull();
  });
  it('says nothing once acknowledged', () => {
    expect(endingCardNote(m(), o({ acknowledged: true }))).toBeNull();
  });
  it('says nothing for a meeting older than seven days, and still does at exactly seven', () => {
    expect(endingCardNote(m({ createdAt: NOW - 7 * DAY - 1 }), o())).toBeNull();
    expect(endingCardNote(m({ createdAt: NOW - 7 * DAY }), o())).not.toBeNull();
  });
  it('says nothing about the Free limit to a phone that is Pro now, but still about every other reason', () => {
    expect(endingCardNote(m({ endReason: 'cap_reached' }), o({ paid: true }))).toBeNull();
    expect(endingCardNote(m({ endReason: 'mic_lost' }), o({ paid: true }))).not.toBeNull();
  });
  it('keys the acknowledgement by meeting', () => {
    expect(endingAckKey('abc')).toBe('ending_ack.abc');
  });
});
