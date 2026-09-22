# Play Store assets

## Phone screenshots — `screenshots/`, ready to upload

Eight 1080×1920 PNGs, numbered in the order they should appear on the listing. Play takes 2–8
phone screenshots; this is the full eight.

| # | Screen | Headline |
|---|---|---|
| 01 | Recording, live | Just hit record |
| 02 | Summary tab | Your meeting, written up |
| 03 | MOM tab | Minutes, not a transcript |
| 04 | Decisions, with anchors | Every decision, with proof |
| 05 | Actions, with owners and dates | Who owes what, by when |
| 06 | Ask, two answers with citations | Ask the meeting anything |
| 07 | Review queue | It shows you its doubts |
| 08 | Before you record | Nothing leaves your phone |

**Why they are composed and not raw captures.** Play rejects a phone screenshot outside a 1:2 to
2:1 ratio. A raw capture off the Pixel 9 emulator is 1080×2424, which is 1 : 2.24, so every shot is
placed on a 1080×1920 (9:16) frame under a headline. Fonts (Nunito) and colours are the app's own.

**Every claim on them is one the app makes.** The free tier's floor and the on-device promise are
both in `src/screens/PaywallScreen.tsx`; the headlines say nothing the build does not do.

**There is deliberately no "who said what" shot.** Diarization collapsed a three-voice recording
into a single speaker on the emulator (14 segments, 1 cluster). The likeliest cause is the audio —
three voices out of one synthesiser share a channel — and the clustering threshold is a measured,
validated value, not a guess; the status note has the detail. Either way a store screenshot is a
promise, so the slot went to Ask. Add one when a real recording shows real speakers.

## Rebuilding them — `tools/`

`aso.py` drives `compose.py`. Put raw 1080×2424 captures in `aso/raw-<key>.png` next to the
scripts, one per row of `SHOTS`, and run `python3 aso.py`. Needs Pillow and the two Nunito faces
in `fonts/`. The frames are regenerated from the raws, so re-capturing one screen does not
disturb the other seven.

## Feature graphic — `feature-graphic.png`

1024×500, RGB with no alpha channel (Play rejects one). Play may crop this and can lay its own
controls over it, so the mark and the words sit in the middle band with a wide margin; the text
sizes itself down to stay inside that margin rather than trusting a hard-coded size.
Rebuild: `python3 tools/feature.py <ic_launcher_foreground.png> feature-graphic.png`.

## Foreground-service videos — `videos/`

Play asks for one per declared service type, showing why the type is needed. Both are ~40 s,
720×1616, no audio track, captured on the Pixel 9 emulator in a single take each.

**`fgs-microphone.mp4`** — the `microphone` type on `RecordingService`. Start a recording; go to
the launcher and the picture-in-picture control keeps counting; pull the shade and the
notification shows the timer with Pause, Mark and Stop; come back and it is still running. That is
the whole case: the recording survives leaving the app.

**`fgs-datasync.mp4`** — the `dataSync` type on `ProcessingService`. The in-app progress screen
with its stages, then the same work reported in the notification from the launcher
("Pulling out the minutes…"), through to "Your notes are ready". The user is waiting for a single
multi-minute computation and can watch it from outside the app.

**Both were shot on an emulator, whose microphone records silence.** The `microphone` take
therefore ends at the stop rather than on real notes, and the `dataSync` one uses a short import.
They demonstrate the service behaviour, which is what review asks for. If review pushes back, the
better answer is sixty seconds on a real phone in a room with real speech —
`tools/fgs_mic_video.sh` and `tools/fgs_sync_video.sh` take a device serial and do it unattended.

## Still missing

Nothing for the store assets. The listing text and the Data safety table live in
`docs/play-console.md`.
