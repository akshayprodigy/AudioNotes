# Announcement verification fixtures

Loudness envelopes from six real recordings made on a Pixel 7 Pro on 6 September 2026, while
proving out the consent announcement. Ground truth is in the filenames, and it is not a guess:

* `heard-1` — the transcript's first line was the disclosure, and the meeting auto-titled itself
  from it.
* `heard-2` — the transcript's first line was "That is the input included by Burger. The recording
  stays on this." Whisper mangled the brand name at a lower volume; the second sentence is verbatim.
* `unheard-1-switched-off` — the Settings toggle was off, so nothing played at all. The control.
* `unheard-2`, `unheard-3`, `unheard-4` — the clip played to completion every time (AudioTrack
  reported all 72076 frames delivered, routing stayed AUDIO_DEVICE_OUT_SPEAKER, onCompletion
  fired, logcat was clean) and the microphone captured nothing. Two of the three came back from
  the pipeline as "no speech found", which is independent corroboration that the audio really was
  empty.

Those four are the entire reason `AnnouncementVerifier` exists: playback completing is not the
same as the room being told, and nothing in the Android audio stack reports the difference.

## What these files are

One line per file, comma-separated integers, wrapped at 100 characters. Each value is the RMS of
one 10 ms frame of 16 kHz mono PCM16 — the same envelope `AnnouncementVerifier.envelope()`
computes. Captures are the first 12 s; `clip.txt` is the whole 4.5 s bundled announcement.

**These are loudness curves at 100 Hz, not audio.** They cannot be inverted to speech, which is
why real recordings of a real room can be committed here at all. Do not replace them with raw PCM.

## If the bundled clip is replaced

`clip.txt` is the clip these captures were recorded against, stored so the test stays
self-consistent when `res/raw/consent_announcement.wav` is swapped for a human recording. The test
pins the ALGORITHM against real-world data; whether a NEW clip survives a real room is a device
check, not a unit test. See the plan's Task 8.
