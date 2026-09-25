# Galaxy A07 — feature pass on the Play internal-testing build (1.0.3 / 10003)

*25 September 2026. Driven entirely over adb (taps, screenshots, the accessibility tree, logcat),
with scripted two-voice speech played from the phone's own speaker. The install came from Play, so
it is signed by Play App Signing — no debug or instrumentation APK can be installed over it
without wiping the app; nothing here is a device-test class. The founder's real 15-minute meeting
(24 Sep, "In IPD what I want…") was not touched.*

**Setup notes for the next run:** the Mac's speakers do not reach this phone's mic (VAD found 0
segments over 199 s); play audio ON the phone instead — `ffmpeg` a WAV into an MP4 with a black
frame, push it, `am start -n com.samsung.android.video/.player.activity.MoviePlayer -d file:///…`
(Verbale drops into PiP, which is itself a test). The Google account on the phone is
`senmithee366@gmail.com`; Play offered the test card only after it was on the licence-testing list
AND Play Store was force-stopped (~8 min after saving). Tester subscriptions end by themselves
within the hour.

## Defects found (most severe first)

1. **Record screen overflows once the Free-limit card appears (last 3 min).** On a 720×1600 phone
   the card is inserted into the vertically centred stage (`RecordScreen.tsx` ~446): the clock is
   pushed up over the status bar and the RECORDING pill, the big Stop button is pushed below
   Pause/Mark and behind the navigation bar, and the card's "Keep recording — 7 days free" button
   is off-screen. The one moment the screen sells Pro is the moment it cannot be used.
2. **A lapsed subscription keeps Pro for up to ~3 days.** `src/billing/subscription.ts:135`
   `if (!res.token) return null;` — when the server answers 200 with `token: null` (not entitled),
   the app keeps its OLD token, which was minted with the 3-day payment grace. Observed: server row
   `status=cancelled`, period ended 51 min earlier, app still "Pro" after four refreshes. The
   lapsed UI (Check again / Manage) therefore cannot appear until the old token runs out.
3. **The consent clip leaks into the transcript — and the title — when it is found but judged too
   quiet.** Verdict `heard=false found=true peak/bg=9.79 loudness=1.20` → `announced_lag_ms` is
   stored only for a HEARD clip, so nothing kept it out of ASR: first line "recorded by Verbali. The
   recording stays on this phone.", Library title "Recorded by Verbali". Exclusion should key on
   `found`, stamping `announced_at` should key on `heard`.
4. **A recording stopped by the Free limit is not processed** (confirmed B2): `reason=cap_reached`,
   notice 45 posted — *"The recording is kept and is being transcribed"* — and nothing ran until the
   Library was opened. The Record screen reset to 00:00 with no word about why.
5. **An announcement nobody heard is reported nowhere** (confirmed B4): volume 2 → `heard=false`,
   Record screen and notification silent.
6. **Renaming a speaker does not reach MOM, Actions or Threads.** Script shows "Samantha"; every
   item still reads "Speaker 1", even after "Regenerate minutes". The owner is baked into the item
   text (`… — Speaker 1 (due by Thursday)`, parsed by `splitAction`) instead of resolved from
   `ownerJson` at render time.
7. **Model mirror 404:** `https://verbale.innocorelabs.com/models/v1/bge-small-en-v1.5-q8_0.gguf`
   (flagged 22 Sep, still missing). The download falls back to Hugging Face and succeeds, but every
   Pro user pays a failed request first. Ops: re-run `mirror-models.sh`.
8. **Settings model rows stick at "1.1 GB of 1.1 GB · 100%" with the spinner** after a download
   completes; reopening Settings shows them installed. The row misses its completion event.
9. **Summary writer states wrong facts** (Qwen 1.5B, 482 chars): "$499/month or $3999/year" for
   "four ninety nine a month" (ASR wrote "499 am"); a report "sent out" that was only promised;
   an invented earlier schedule ("had been scheduled for Tuesday but has now been postponed").
10. **Ask cites "[4] Minutes · 0:00"** — the written minutes — instead of the transcript moment
    (0:21), against the screen's own promise. Answer itself correct (46 s) plus one unasked sentence.
11. **Meaning search has no relevance floor:** "pricing" → 44 matches in 4 meetings, including
    "≈ Book the demo room for Friday". Search rows also show the raw "— Unassigned" suffix.
12. **Extractor on real ASR text:** "Let's start the weekly check-in…" is an ACTION; "Rahul will
    recruit ten more testers by Monday" is not (`<Name> will <verb>` verb list); "before Wednesday"
    gets no due date; a transcript correction ("Verbal"→"Verbale") does not update the items built
    from the line.
13. **Play Console, not code:** prices are ₹300 / ₹2,500 (founder's final: ₹299 / ₹2,499); the
    subscription benefits list says "Export meetings (MP3, SRT, PDF)" — there is no MP3 export and
    export is free.

Lower: the Free limit stops at 15:15, not 15:00 (checked every ~32 s); "Good morning everyone."
(the first line) missing from both mic recordings but present in the imported file — cause not
found (the announcement exclusion removed exactly one span, the clip); whisper hears "comma" as
"Kama", so dictation commas fail; a dictation is auto-titled "Afternoon meeting"; the Free summary
card says "processed before summaries were written"; the meeting overflow sheet hides Archive/Delete
below the fold with no scroll cue; the model row's "· 100%" is clipped at the right edge.

## Passed on this phone

Record (meter, timer, Free-limit line) · announcement verified heard (peak 8–11× background) and
kept out of ASR · Mark ("Marked 0:46") · Pause holds the clock · Stop from the notification · PiP
on leaving the app, with "00:11 / 15:00" · Stop from the PiP menu · headless processing (229 s in
~35 s) · "Your notes are ready" → opens the meeting, not the paywall · Script / MOM / Actions,
decisions with play-from anchors · tick an action · add an action by hand ("ADDED BY YOU") · Redo
keeps the tick and the hand-typed action · rename, tag, tag filter · Export → PDF named after the
meeting · Speakers rename (Script) · playback · every Settings section · dark mode live · open-source
notices · network ledger (0 bytes sent, 96.3 MB received) · Clear empty recordings with a counted
confirm · Free gating of Search and Actions · Pro screen: ₹300 / ₹2,500, "save 31%", 7-day terms,
Restore → "Nothing to restore", "Subscribed on the web? Sign in" · import a WAV · Dictation mode
(full stops, new paragraph; mode remembered) · Delete with a named confirm · Archive + Restore ·
**Phase A:** Settings → See Pro plans opens the Pro screen (A1); test purchase → "Your free trial
has started", server verified; Settings and the Library's "open actions" card show Pro with no
restart (A3/A5); Manage subscription → Play's page · writer + meaning index download · summary
written (4.7× realtime) · review queue ("3 items need a look") · Ask · Search (exact first) ·
vocabulary: typed rule, and a correction that offers "Always write…" with NO/YES · Actions worklist
across 5 meetings · Threads (still open / decisions so far).

## Not tested, and why

Payment received while offline and the slow test card (Phase A §7 2–3); Restore after clearing
data and reinstall ×3 (§7 4, 7) — **both would erase the founder's real meeting on this phone**;
the lapsed UI (§7 6) — blocked by defect 2; remembered voices; speaker merge (the synthetic voices
diarize as one speaker); Write it again / meeting-type change (B1, known from code); Whisper small;
backup/restore; Quick Settings tile; mic lost / disk full; the 90-minute capture.

**Left on the phone:** five test meetings (Beta weekly check-in, two "Good morning…" imports, the
"Recorded by Verbali" dictation, a 15-minute no-speech recording). Restored: media volume 0, screen
timeout 10 min, theme System (light), vocabulary empty, `/sdcard/Download/verbale-test` removed.
