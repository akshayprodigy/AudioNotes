# Marks and capture warnings — design

**15 September 2026.** Sub-project 2A of the 15 September sequence (after the local gate). Two
things on the record screen and its shadows — the PiP window and the notification — that the
7 September report asked for and the 14 September pass confirmed absent.

Decisions taken on the day: a mark becomes a Highlights section (not yet a narrator hint);
**no live transcript on screen** (the founder's call — the live pass stays a cache); warnings are
inline and never block; no separate mic-check screen.

## 1. Marks

**Tap.** "Mark" on the record screen, a third action in the PiP window, a third action on the
recording notification. Each records the moment on the recording's own clock — bytes written
÷ 32, the pause-adjusted timeline the transcript uses — vibrates once, and shows "Marked 12:34"
for two seconds on the record screen (the screen listens for marks made elsewhere too). A mark
while paused records the current position; it is harmless and the caption says so.

**Store.** A `marks` table: `id`, `meeting_id` (cascade), `at_ms`, `created_at`. Keyed on time,
not on items, so a reprocess has nothing to reconcile and can never lose one. Both schema mirrors
carry it.

**Show.** A **Highlights** section at the top of the Summary tab. `highlightsFor(marks,
utterances)` — one pure function, TypeScript, tested — resolves each mark to the utterance that
spans it, else the next utterance starting within 15 s, else no text. Each highlight is a card:
the sentence (or "nothing said here yet"), the stamp, the same provenance button items have, and
a small × that removes the mark. Order is the recording's order.

**Export.** Markdown, plain text and PDF gain a "Highlights" section before Decisions, each line
`[m:ss] sentence`, absent when there are no marks. The Kotlin reader resolves marks against turns
with the same rule as `highlightsFor`; one shared fixture pins both.

## 2. Capture warnings

Three conditions, each computed natively from what the capture loop already has, each **logged
every time it starts and stops** with its numbers — the thresholds are guesses until phones argue
with them:

| Condition | Rule | Text |
|---|---|---|
| Too loud | > 1 % of samples at full scale over the last 2 s | "Too loud — move the phone a little further from the speakers." |
| Faint | the live VAD saw ≥ 10 s of speech in the last 60 s and the mean level during it was under −54 dBFS | "Voices are faint — move the phone closer to the people talking." |
| Storage | free space under 3 × the existing hard stop | "About N minutes of storage left." (N from the free bytes at 32 bytes/ms) |

Precedence when two hold: storage, then loud, then faint. One warning at a time.

**Surface.** `CaptureController.warning` (code + text), pushed to JS as `onCaptureWarning` when it
changes; an amber, non-blocking banner under the level meter; the notification's body line while
it holds. Both clear when the condition clears. Nothing pauses, nothing blocks — the recording is
the thing being protected.

**Faint speech needs the VAD.** `LiveTranscriber` already runs Silero over the growing file and
holds the speech spans; after each feed it reports the new spans to `CaptureController`, which
holds a 60-second ring of per-buffer RMS with timestamps and computes the mean level inside those
spans. No second detector.

**Tests.** `CaptureWarnings` is a pure Kotlin object — clipping fraction, the faint rule, the
minutes-left arithmetic, precedence — with JVM tests. The ring buffer is its own small class with
tests. The wiring is verified on the Pixel: mark from all three places, highlights and export,
loud and faint warnings provoked from the Mac's speakers.

## Out of scope

Feeding marks to the narrator; a mic-check step; warnings in the PiP window; word-level anything.

## Device verification — Pixel 7 Pro, Android 17, 15 Sep 2026

Release APK, real library (20 meetings). Speech from the Mac's speakers (`say`, two voices),
about 20 cm from the phone.

**Marks, three surfaces, one recording (4 min 29 s).** PiP menu → Mark at 94.8 s; the record
screen's Mark button at 152.7 s ("Marked 2:32" on the button, gone after 2 s); the notification's
Mark at 269.6 s. Summary showed three highlights, each the sentence being said at that moment
("Thanks for joining the launch review. First, the release date." for the PiP mark, which landed
in a pause 11 s before that sentence began — inside the 15 s forward gap), each stamped with the
sentence's start. Tapping one opened the Script tab and played from 2:29 with the line lit; ×
removed the third (3 → 2). Copy (the Markdown document) carried `## Highlights` above Decisions,
in mark order, with the mark's own stamp:

```
- [1:34] Thanks for joining the launch review. First, the release date.
- [2:32] Good afternoon everyone. Thanks for joining the product sync. Let us start with the launch date.
```

A mark taken before any speech and never followed by any (the recording a reinstall killed at
101 s) rendered "Nothing said here yet" with the mark's own time — the designed fallback.

**Two defects found and fixed in the run.**

1. *Mark from the notification ended the meeting.* `ACTION_MARK` was handled in `onStartCommand`'s
   `when` and, having no `return`, ran on into the "no meeting/audio path" guard and `stopSelf()`:
   `marked 269568ms` then, 120 ms later, `capture ended (stopped)`. The comment above that `when`
   described exactly this failure mode for Pause. `onStartCommand` is now one exhaustive
   `when`-expression over a `StartRoute` decided by a pure `routeFor(action, hasMeeting)`;
   `StartRouteTest` holds every control action against `hasMeeting=false` and fails when the
   MARK line is removed. Re-verified: notification Mark at 44 s, recording continued to 139 s.
2. *"Marked m:ss" stood in the shade until the next minute tick.* One delayed refresh after the
   caption's window. Re-verified: "Marked 0:44" at +1.5 s, "Everything stays on this device" at
   +7.5 s.

**PiP.** Entered on Home with `[Pause|Mark|Stop]`; the earlier session's "PiP never appears" was
the first launch after an install — it has entered every time since. The swallowed exception in
`enterIfRecording` is now logged.

**Faint.** Provoked at 50 % Mac volume: `warning null -> FAINT: speechMs=15328 meanRms=0.0011`
(−59 dBFS) about 15 s into the quiet speech; amber banner on the record screen, "Voices are
faint — move the phone closer…" as the notification body; `FAINT -> null` 60 s after the speech
stopped. At 100 % the same speech read −46 dBFS (0.0044–0.0053) — 8 dB above the line, and the
A07's clean meeting sat at −48, so the −54 dBFS threshold has the right neighbours.

*Finding, not fixed:* at 25 % volume the Silero VAD saw only 4.4 s of speech per minute
(`speechMs=4372, meanRms=0.0021`), under the 10 s the rule needs, so no warning — and the
transcript would have been nearly empty too. Below the band where the VAD still hears speech,
"faint" cannot fire; a "nothing heard for N minutes while the meter moves" condition would cover
it and is a separate design question (silent stretches are normal in meetings).

**Loud.** Not provokable from a speaker: the Mac at 100 % 20 cm from the phone reads `clip=0.0000`
on the Pixel's VOICE_RECOGNITION input. `CaptureWarningsTest` covers the arithmetic; the wiring
is the same path the faint warning took. A physical overload (a breath across the mic) is the
way to see it on a phone.

**Storage.** Unit-tested only (`minutesLeft`, precedence); the phone has 9.4 GB free.

**Level log.** `CaptureController` now logs `levels: clip= speechMs= meanRms=` every ~30 s of
capture, so the next phone's numbers are read off logcat rather than guessed.
