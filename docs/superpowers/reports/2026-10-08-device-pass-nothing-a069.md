# Device pass — Nothing A069 (8 October 2026)

*The first time the October build ran on hardware. Phone: Nothing A069, Android 16, arm64, 11.7 GB RAM, ~215 GB free, fresh install (no Verbale before). Release APK built from `main` (`npm run apk`); debug test APKs for T1. Item IDs are those of `2026-10-07-device-test-checklist.md`. Audio for the by-hand checks was scripted speech played from the Mac's speakers about 20 cm from the phone (`say`, voices Samantha and Daniel), so every voice in these meetings was diarized as ONE speaker; the checks that need two real people (C9, C18) are not covered. Evidence is what was seen on screen and in `adb logcat`; nothing has been checked by a second person. Clock-change checks used `adb shell cmd alarm set-time` with automatic time off, restored afterwards.*

## Fixed during the pass (each has tests and mutants; none re-checked by a person yet beyond what is written)

| commit | what the phone showed | fix |
|---|---|---|
| `d05d36b`, `6f3b6dd` | "Let's wrap up there." (whisper wrote "…wrap up that.") was listed as an action owned by Speaker 1 | closing/flow phrases (wrap up there/here/that/this/it at the end, move on, get going, call it a day) are not actions; "wrap up the migration" still is. TS and C++ together, F16 goldens +5 rows. **The second commit was written because the first was tested against typed text; whisper wrote something else.** |
| `bf1fba2` | after renaming Speaker 1 → Priya the Share preview's top paragraph still said "— Speaker 1" above a list saying "— Priya" | the stored rule overview is re-resolved with the renamed owners at export time. **Re-checked on the phone with the new build: reads "— Priya".** |
| `f20c212` | an 8 s dictation "Call Priya at five o'clock tomorrow and send her the budget." was transcribed as **"And punch it."** | Dictation mode played the "this meeting is being recorded" clip and ASR cut the first ~5.7 s with it. A dictation is now never announced. **Re-checked on the phone: whole sentence transcribed** ("Call PrehiHot 5 o'clock tomorrow and center the budget" — proper nouns misheard, nothing missing). |
| `81884db` | **App crashed ("Application Error") when the font size was changed with it open** — `IllegalStateException: Screen fragments should never be restored`, from `MainActivity.onCreate` | `super.onCreate(null)`, the react-native-screens documented fix. It also covers Android restoring the activity after killing the app in the background (not simulated successfully — see below). **Re-checked: font scale, display size and density changed with the app open — no crash.** |
| `1223316` | stopping a recording with the **stop button on the strip** shown on the Library ended the capture and **nothing queued it for processing** (no pipeline lines; meeting left "captured", slot RESERVED until some other screen's sweep ran) | the strip now queues processing after stopping, as the Record screen does. **Re-checked: stop from the strip → processing starts at once → COMMIT.** |
| `b498a7d` | the Pro nudge card on the Library spanned the full width while the cards below were inset; the exhausted card's "Get Pro" had a tick icon | card inset like the meeting cards; the button carries the Pro mark. |
| `aabaa1f` | the exhausted Record screen: the card cut the mascot's head off, the mic looked live, and the hint still said "Tap to start recording · up to 1 hour on Free" above a card saying you can't | no mascot while spent; the hint reads "Free meetings are used up until <date>"; the mic is dimmed. **Jest only - not looked at on the phone yet.** |
| `79475b4` | (not a defect) no way to see why a session did or did not take a slot on a release phone | one log line per settle decision. |

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
| A5 short meeting with words | **PASS** | A 21.5 s Meeting-mode recording (speech from 8 s): log `WAIT` at capture end, `WAIT` after speech detection, `COMMIT` when processing finished with a usable transcript; Library 4 → 3 of 5. **Correction to an earlier version of this log:** two short "meetings" that appeared not to count (22 s and 18 s) were recorded in **Dictation** mode — the Record screen remembers the last mode and my script never switched back; a dictation under a minute is free by your decision, so the slots were right. |
| A9 clock back to 15 Sep with 5 used | **PASS** | still "0 of 5 … resets 1 November", Record refused. |
| A10 one session under Jan 2027, clock back to Oct | **PASS** | at Jan: "5 of 5 … resets 1 February"; after recording "4 of 5"; back in Oct: "0 of 5 … resets 1 November" (read as this month), never "1 February 2027". |
| rollover, clock 1 Nov 00:05 | **PASS** | "4 of 5 free meetings left · resets 1 December." — October no longer counts; the January entry is read as November. The midnight-crossing-during-a-recording variant (A11) was not run. |
| X1 rename | **PASS after fix** | Actions tab "Owner Priya" live; Share preview list and (after `bf1fba2`) overview; Markdown transcript lines "**Priya:**"; named "Maya"/"Sam" untouched. |
| X6 real-microphone extractor | **PASS after fix** | "Let's start the weekly check-in", "Priya will be late", "We will not ship Friday" → not actions; "I'll send the report … by the end of the week", "Maya will book the room" → actions with owner/due. Whisper (base) wrote "Rattle" for "Rahul", "First, price it." for "First, pricing.", "And you'll next time." for "annual next time", "health articles" for "help articles". |
| H1/H3 Share, formats, credit | **PASS (partly)** | Share screen shows PDF/Markdown/Text/Subtitles; Markdown preview; the credit toggle puts "*Created with Verbale — private meeting notes*" last. The label does not toggle the switch (only the switch does). The system share sheet opens with "Good morning everyone l…the weekly check-in.md"; nothing was sent. PDF/Subtitles file contents, H4, H6 not checked. |
| Processing speed | observed | 171 s of audio: VAD 1.4 s, ASR 21.8 s (0.13×), diarization 21.2 s, minutes 0.1 s. An 8 s dictation took 11.4 s of ASR (1.42×). |
| Consent clip | **PASS** | `announcement check: heard=true found=true … lag=300ms`; banner "Announced at the start of the recording." |

| R1/R2 Record screen at 384×853 dp and at font scale 2.0 | **PASS (recording and idle); clipped text** | At 384 dp: idle shows the clock, hint, mic and the remaining line; recording shows the clock, hint, big Stop, Pause and Mark, all on screen. At 200% text on top of that: Stop, Pause and Mark still on screen and reachable; but the header "Meeting · Thu 8 Oct" and the footer "Stays on this device. Show the room" are clipped at the edges, and the remaining-meetings line is not shown. The **warning-phase** layout (R1 proper: card under the clock at 5 minutes left) needs the short-cap build and was not run. R3 (exhausted card at both sizes) not run. |
| Library at 200% text, 384 dp | **layout defects** | the title breaks mid-word ("Meetin / gs"), the header wraps to six lines, the initials chip on a card is clipped, titles truncate to "budge..". |
| A17 import over the Free hour | **PASS** | 61-minute file: "That recording is longer than the 1 hour Free limit. Pro has no length limit." with Not now / Get Pro; no meeting row, no slot. |
| A18 corrupt file | **PASS** | "Could not import that — That file could not be opened"; no meeting row, no slot. |
| Import of a valid file | **PASS** | 17 s spoken file → decoded 17.0 s, WAIT, WAIT, COMMIT; one slot; the app opened the new meeting. |
| A19 import while recording | **PASS, with a nit** | "Could not import that — Finish recording first" (after choosing a file; the picker itself still opens). The reverse (record while importing) was not run. |
| A20 / C11 force-stop mid-recording | **PASS** | `recovered 1 meeting(s) stranded in 'recording'` on the next launch; 18.4 s kept; processed without a tap; one slot committed (4 → 3). |


| X3 correct a word | **PASS** | a corrected word reached the action, the minutes and the Library card; search "Rahul" found 3 matches; the auto-title stays "Rattle…" (not rewritten). |
| Settings | **PASS** | "Free allowance: 1 of 5 left · resets 1 December", theme, crash reports. |
| Dark mode | **PASS** on Settings, Library, Record | consistent. Meeting screen in dark not checked. |
| R3 exhausted Record screen (`aabaa1f`) | **PASS at 408 dp; usable but cramped at 384 dp + 200% text** | At normal size: no mascot, card with the Pro-mark button, hint "Free meetings are used up until 1 December", dimmed mic. At 384 dp and 200% text the card's band is only ~10% of the screen high, so the text and "Get Pro" are reached by scrolling inside it (works), with a large empty gap above the mic; header "Meeting · Thu 8 Oct" and the footer are clipped as before. The card also touches the Meeting/Dictation switch with no gap. |
| Meeting screen in dark mode | **PASS** | Summary, Decisions/Next steps/Open questions, player bar, menu sheet all legible. |
| Add to project (Free) | **PASS** | sheet says "Projects are part of Pro", points to "Add a tag", Upgrade / Not now. Nothing created. |
| Theme restored | done | Settings → Theme is System again; real time, automatic time on, density and font scale reset. |
| Short-cap run (A4/A12/A13) | **PARTLY** | a 7-minute-cap build was installed. The first three minutes ran and a pause at 3:01 was taken; the rest of the scripted run (warning card, final minute, stop at the limit) produced **empty screenshots and no log lines**: the phone's owner had started using it (YouTube had focus, so the tap guard refused). The limit logic is covered by jest only; **not seen on a phone**. |

## Findings not yet fixed

1. **Speech in the first ~5.7 s of a meeting is cut from the transcript** (checklist C10 / D16 hypothesis, now observed): the announcement clip's window is excluded from ASR and overlapping words go with it. Audio keeps it. The Record screen says nothing about waiting for the clip. Product call: say "Announcing…" and hold a "start speaking" hint, or trim only the clip's own samples.
2. **Progress estimate overstated:** "10% · about 4 min left" for a 171 s recording that took ~45 s; "about 34s left" for 64 s that took ~16 s.
3. **Record screen idle shows no "N of 5 left" line on the Meeting tab at 5 of 5**; the Dictation tab does show it at 4 of 5. Probably "hidden while full" — confirm it is intended.
4. ~~Exhausted Record screen~~ fixed in `aabaa1f` (see above); needs a look on the phone.
5. **Tile refusal lands on the Library**, which carries only the small grey count line; the card that explains is on the Record screen.
6. ~~Pro nudge card full width~~ fixed in `b498a7d`.
7. **A dictation's Summary tab** shows the meeting boilerplate and "Try it free for 7 days"; and the processing screen lists "Speakers separated" for a dictation.
8. **Header title cut to "Weekly c…"** on the sample; label of the credit switch is not tappable.
9. **The Pro screen opened by itself once** (11:36, first processed meeting); not reproduced in five later recordings and no automatic trigger exists in code; treat as a stray tap until seen again.
10. **Phone locks while idle**; adb cannot unlock it. `svc power stayon true` while plugged in avoids it. adb connection to the phone dropped twice (cable); at the end of the session it did not come back.

11. **Record screen remembers its last mode** (Meeting/Dictation). Easy to start a meeting in Dictation by accident; the only cue is the highlighted tab and "Tap to dictate".
12. **Two jest suites failed once each in a full run** (`MeetingScreen` F15 "does not re-read the items…", `AddToProjectSheet`) and pass 3 of 3 alone and on the previous commit: timing-sensitive tests that flake when the machine is loaded.
13. **Restore-from-background was not exercised:** with "don't keep activities" on, the activity was not actually destroyed (the task was just brought to front). The crash fix is verified for the font/size/density path only.
14. **Notifications and other apps took focus several times** (a WhatsApp heads-up, YouTube, the launcher) while the phone was in use; my tap guard refused each time, which is why some steps were repeated.

## An incident to know about

While driving the phone I pressed Back three times from the Library without checking where I was; that left Verbale for the launcher and three coordinate taps then landed in the **Google/Gemini app** (the phone owner's personal chat). Nothing was typed or sent; one screenshot of the conversation was taken by the tool. A sentence I spoke from the Mac ("Call Priya at five o'clock tomorrow and send her the budget.") may have been heard if Gemini's microphone was active. I left the app, confirmed nothing was playing, and every tap now goes through `g.sh`, which refuses unless Verbale (or its own permission/share dialogs) has focus.

## Not done yet in this pass

Clock midnight crossing during a recording (A11), disk-full (A22, C13), the warning-phase Record layout and the exhausted card at small sizes (R1, R3), PDF/Subtitles contents and Share at large text, X4–X5, Add to project, dark mode on the meeting screen, TalkBack, the real one-hour cap (A14), the short-cap run to the end (A4, A12, A13), record-while-importing, and the restore-from-recents crash path. Follow-up card and Ask need Pro. Not possible with one phone and no second person: C9, C15, C16, C18, billing (B1–B6), the Play-installed migration (A23).
