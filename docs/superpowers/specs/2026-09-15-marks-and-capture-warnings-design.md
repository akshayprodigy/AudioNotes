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
