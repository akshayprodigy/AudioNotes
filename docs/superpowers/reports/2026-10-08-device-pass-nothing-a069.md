# Device pass — Nothing A069 (8 October 2026)

*The first time the October build ran on hardware. Phone: Nothing A069, Android 16, arm64, 11.7 GB RAM, ~215 GB free, fresh install (no Verbale before). Release APK built from `main` (`npm run apk`); debug test APKs for T1. Item IDs are those of `2026-10-07-device-test-checklist.md`. Audio for the by-hand checks was scripted speech played from the Mac's speakers about 20 cm from the phone (`say`, voices Samantha and Daniel), so every voice in these meetings was diarized as ONE speaker; the checks that need two real people (C9, C18) are not covered. Evidence is what was seen on screen and in `adb logcat`; nothing has been checked by a second person. Clock-change checks used `adb shell cmd alarm set-time` with automatic time off, restored afterwards.*

## Fixed during the pass (each has tests and mutants; none re-checked by a person yet beyond what is written)

| commit | what the phone showed | fix |
|---|---|---|
| `d05d36b`, `6f3b6dd` | "Let's wrap up there." (whisper wrote "…wrap up that.") was listed as an action owned by Speaker 1 | closing/flow phrases (wrap up there/here/that/this/it at the end, move on, get going, call it a day) are not actions; "wrap up the migration" still is. TS and C++ together, F16 goldens +5 rows. **The second commit was written because the first was tested against typed text; whisper wrote something else.** |
| `bf1fba2` | after renaming Speaker 1 → Priya the Share preview's top paragraph still said "— Speaker 1" above a list saying "— Priya" | the stored rule overview is re-resolved with the renamed owners at export time. **Re-checked on the phone with the new build: reads "— Priya".** |
| `f20c212` | an 8 s dictation "Call Priya at five o'clock tomorrow and send her the budget." was transcribed as **"And punch it."** | Dictation mode played the "this meeting is being recorded" clip and ASR cut the first ~5.7 s with it. A dictation is now never announced. **Re-checked on the phone: whole sentence transcribed** ("Call PrehiHot 5 o'clock tomorrow and center the budget" — proper nouns misheard, nothing missing). |

## Results

| item | result | what was seen |
|---|---|---|
| T1 whole instrumented suite | **PASS** | 18 classes all `OK`, including `SpeakerRenameDbTest` (4) and `CorrectionsDbTest` (9). Qwen/bge-small tests skipped (models not installed here). |
| O1 first screen | **PASS, one correction** | one primary button, sample button, Pro link. The button says **96 MB, not 114 MB**: the release APK bundles `libonnxruntime.so`. The checklist's 114 MB was stale. |
| O2/O3 sample | **PASS** | opens offline with the SAMPLE banner; audio plays; "Play from 0:22" seeks and plays. Not every source link tapped. |
| N1/N2/N3 tabs, Minutes order, card line | **PASS (N3 partly)** | tabs Summary/Minutes/Transcript/Actions; takeaway, "Ask this meeting", Decisions, Next steps. The Library's "Decided:" line shows on the large cards only — the smaller cards of the varied-size layout carry no preview line. |
| A1 count after ≥60 s | **PASS** | 171.5 s recording → "4 of 5 free meetings left · resets 1 November."; sample excluded from "saved". Five counted meetings → "0 of 5". |
| A2 exhausted state | **PASS** | exact card text + "Get Pro"; tapping the mic starts nothing (no recording service). |
| A3 tile with 0 left, app killed | **PASS** | `ShimActivity: quick start refused: allowance used up until 2026-11-01; opening the app`; no recording service. The app lands on the Library (not the Record screen's explanation). |
| A5 silence | **PASS** | 11 s silent meeting → log "ASR skipped (no speech detected)", count unchanged (4 of 5), meeting says "Nothing to show". |
| A5 dictation | **PASS** | 8 s dictation with real words → count unchanged. |
| A5 short meeting with words | **not shown cleanly** | a 22 s meeting did not take a slot — but its words were lost to the announcement clip (see dictation fix), so the transcript was not "usable" and the refund is the designed outcome. **Re-test after the announcement fix is not done** (phone disconnected). |
| A9 clock back to 15 Sep with 5 used | **PASS** | still "0 of 5 … resets 1 November", Record refused. |
| A10 one session under Jan 2027, clock back to Oct | **PASS** | at Jan: "5 of 5 … resets 1 February"; after recording "4 of 5"; back in Oct: "0 of 5 … resets 1 November" (read as this month), never "1 February 2027". |
| rollover, clock 1 Nov 00:05 | **PASS** | "4 of 5 free meetings left · resets 1 December." — October no longer counts; the January entry is read as November. The midnight-crossing-during-a-recording variant (A11) was not run. |
| X1 rename | **PASS after fix** | Actions tab "Owner Priya" live; Share preview list and (after `bf1fba2`) overview; Markdown transcript lines "**Priya:**"; named "Maya"/"Sam" untouched. |
| X6 real-microphone extractor | **PASS after fix** | "Let's start the weekly check-in", "Priya will be late", "We will not ship Friday" → not actions; "I'll send the report … by the end of the week", "Maya will book the room" → actions with owner/due. Whisper (base) wrote "Rattle" for "Rahul", "First, price it." for "First, pricing.", "And you'll next time." for "annual next time", "health articles" for "help articles". |
| H1/H3 Share, formats, credit | **PASS (partly)** | Share screen shows PDF/Markdown/Text/Subtitles; Markdown preview; the credit toggle puts "*Created with Verbale — private meeting notes*" last. The label does not toggle the switch (only the switch does). The system share sheet opens with "Good morning everyone l…the weekly check-in.md"; nothing was sent. PDF/Subtitles file contents, H4, H6 not checked. |
| Processing speed | observed | 171 s of audio: VAD 1.4 s, ASR 21.8 s (0.13×), diarization 21.2 s, minutes 0.1 s. An 8 s dictation took 11.4 s of ASR (1.42×). |
| Consent clip | **PASS** | `announcement check: heard=true found=true … lag=300ms`; banner "Announced at the start of the recording." |

## Findings not yet fixed

1. **Speech in the first ~5.7 s of a meeting is cut from the transcript** (checklist C10 / D16 hypothesis, now observed): the announcement clip's window is excluded from ASR and overlapping words go with it. Audio keeps it. The Record screen says nothing about waiting for the clip. Product call: say "Announcing…" and hold a "start speaking" hint, or trim only the clip's own samples.
2. **Progress estimate overstated:** "10% · about 4 min left" for a 171 s recording that took ~45 s; "about 34s left" for 64 s that took ~16 s.
3. **Record screen idle shows no "N of 5 left" line on the Meeting tab at 5 of 5**; the Dictation tab does show it at 4 of 5. Probably "hidden while full" — confirm it is intended.
4. **Exhausted Record screen:** the mascot's head is clipped under the Meeting/Dictation switch; "Get Pro" has a tick icon; the big blue mic still looks live and the hint still says "Tap to start recording · up to 1 hour on Free" above a card saying you can't.
5. **Tile refusal lands on the Library**, which carries only the small grey count line; the card that explains is on the Record screen.
6. **Pro nudge card on the Library** ("Your 5 meetings, written up") spans the full screen width while the cards below are inset.
7. **A dictation's Summary tab** shows the meeting boilerplate and "Try it free for 7 days"; and the processing screen lists "Speakers separated" for a dictation.
8. **Header title cut to "Weekly c…"** on the sample; label of the credit switch is not tappable.
9. **The Pro screen opened by itself once** (11:36, first processed meeting); not reproduced in five later recordings and no automatic trigger exists in code; treat as a stray tap until seen again.
10. **Phone locks while idle**; adb cannot unlock it. `svc power stayon true` while plugged in avoids it. adb connection to the phone dropped twice (cable); at the end of the session it did not come back.

## An incident to know about

While driving the phone I pressed Back three times from the Library without checking where I was; that left Verbale for the launcher and three coordinate taps then landed in the **Google/Gemini app** (the phone owner's personal chat). Nothing was typed or sent; one screenshot of the conversation was taken by the tool. A sentence I spoke from the Mac ("Call Priya at five o'clock tomorrow and send her the budget.") may have been heard if Gemini's microphone was active. I left the app, confirmed nothing was playing, and every tap now goes through `g.sh`, which refuses unless Verbale (or its own permission/share dialogs) has focus.

## Not done yet in this pass

Clock midnight crossing (A11), imports (A17–A19), kill/recover (A20, C11, C12), disk-full (A22, C13), Record layout at large text and 384×853 (R1–R3), PDF/Subtitles contents and large text on Share, corrections (X3–X5), follow-up card, Add to project, Settings, dark mode, TalkBack, the real one-hour cap (A14), the short-cap timing build (A4, A12, A13). Not possible with one phone and no second person: C9, C15, C16, C18, billing (B1–B6), the Play-installed migration (A23).
