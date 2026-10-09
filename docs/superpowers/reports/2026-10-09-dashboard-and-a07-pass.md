# 9 October 2026 — the dashboard, the Galaxy A07 first-run and Pro pass

Phones: Nothing A069 (the founder's, strip and processing screen), Galaxy A07 SM-A075F (fresh install: first run, Free pass, then a Pro test build that treated the phone as Pro). Gate at the end: types, js (1,253), scans, mutations, Kotlin (571), C++ (31) all clear.

## Decisions (founder, 9 Oct)
- The processing pill says "NN% · In progress", never a time. A wrong time reads as a fault.
- Dictation stays refused at 0 of 5 meetings left.
- No Pro sheet opens by itself over the first finished meeting.

## Built
| change | commit area |
|---|---|
| Library header: one strip, SAVED / CAPTURED / FREE LEFT (amber when spent), stacks at large text, one spoken sentence for a screen reader | `LibrarySummary.tsx`, `summaryStats.ts` |
| Processing pill "In progress"; the percentage can never run ahead of the stage checklist | `MeetingScreen`, `progress.ts` |
| No Pro sheet over the first notes | `MeetingScreen` |

## Defects found by the A07 and fixed
1. **First-run note had no words** (icon only): the Record screen centres its scroll content and a centred card shrink-wraps, so `flex: 1` text measured zero. Only a fresh install shows the card.
2. **200% text**: Library card time ran off the edge; Meeting header broke "Let's" mid-word (READY now moves under the title); Settings model rows squeezed their words into a third of the width; Summary header wrapped.
3. **A 5 s accidental recording** (just its own announcement) became a READY meeting that took a slot. Slot now returned (`ANNOUNCEMENT_ONLY_MS` = 7 s) and the capture is read as empty, not transcribed (only for in-app recordings: an import has no announcement, so a 5 s imported voice note is unaffected).
4. **Percentage ahead of the checklist** ("99%" with speaker separation 29 of 129).
5. **Ask loop**: the grammar allowed unlimited citations, so an unanswerable question ran to the token cap. Now at most three. A cited answer that talks about "the passages" is the model failing to answer and is the "nothing" state.
6. **False "Contradicted"**: a pause split one sentence; its own tail "contradicted" it. A reply that is a lowercase fragment after an unfinished turn can no longer contradict.
7. **Extractor**: "Let's go through/over/walk through/run through …" opens an agenda item, not an action (a time or second cue keeps it one). JS and C++ in step; goldens regenerated.
8. **Disk full mid-recording** was reported as "the audio could not be saved"; a no-space error is now `disk_full` ("the phone ran out of space").
9. **Create project** button sat behind the navigation bar; search placeholder clipped.

## Verified on the phone (A07)
First run and 96 MB setup (~1 min); import through the file picker; dictation under 60 s takes no slot; restore after the app was destroyed (no crash); a recording crossing midnight into 1 Nov counts to the month it started; Mark; Pause/Resume; warning card ("4:41 left" at 2:19); storage warning; **short-cap run to the real stop** (7-minute native cap: warning at 2:00, "0:54 left", stop at 7:01 "Stopped at the Free limit. Everything up to that point is kept.", slot committed); all four Share formats; Pro: models download and run on 3.7 GB, written summary (accurate on an 82 s meeting; declines under ~30 s), meaning search (≈), Ask with tappable sources, Actions, Follow-up card, review queue, projects.

## Not fixed / not verified
- The first-ever A07 recording stopped itself after 4.6 s. Not reproduced; the start path (`RecordScreen.onToggle`) reads correctly and the cause may have been the test tap. Worth one clean first-run repeat.
- Ask still gives a vague (but now bounded and cited) answer to some unanswerable questions on the 1.5B writer.
- After the fixes in items 3, 5, 6, 8, 9 the final build was not re-installed on the A07 (the phone was unplugged).
- Not run: TalkBack, notification Stop/Mark, picture-in-picture, remembered voices, vocabulary, threads, "Write it again".
- The A07 shows 0 of 5 until 1 Nov (clock excursions); a reinstall resets it.
