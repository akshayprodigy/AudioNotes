import { announceLine, endingNote, holdFor } from '../meetingNotes';

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
