# Workstream C — Faster first value

Branch `dev/october-plan`. Built 7 Oct 2026. Nothing was run on a phone; every device claim is listed under "Device checks owed".

## What was built

1. **A bundled, offline, labelled sample meeting.** `scripts/make-sample-meeting.sh` renders a fictional two-person "Weekly check-in" with two macOS `say` voices (Samantha, Daniel), joins the lines with 0.7 s pauses, encodes AAC mono 32 kbps, decodes that back, and runs the repo's real CLI (`cpp/cli/build/audionotes_cli` + `ggml-base-q5_1.bin` + Silero VAD) over exactly the shipped audio. `scripts/sample-meeting-bundle.js` maps each pipeline utterance to the script line it overlaps (times are the pipeline's), takes the speaker names from the script (two synthetic voices diarize as one speaker), and runs the app's OWN rule extractor (`src/pipeline/evidence.ts`, `minutes.ts`) for items, owners, due dates, anchors and the summary. Output: `android/app/src/main/res/raw/sample_meeting.m4a` and `src/sample/sampleMeeting.json`. Two runs give byte-identical files.
   - **Size:** audio 263,014 bytes (≈ 0.26 MB; AAC in `res/raw` is stored as-is) + JSON 6,653 bytes. APK growth is therefore about 0.27 MB. Not measured on a built APK.
   - **Duration:** 64.5 s, 12 turns.
   - **Words are the script's, not whisper's.** whisper-base on synthetic voices wrote "Hellbent articles", "the theme" and "Praya"; a demo that opens on mishearings teaches the wrong lesson. Times, items, anchors and the summary are real pipeline/extractor output. A price said in words is written "$4,500", as the pipeline itself rendered it. `sampleMeeting.test.ts` pins that every item and the summary are exactly what the extractor produces from the transcript.
2. **Seed and identify** (`src/sample/`). `seedSample.ts` inserts meeting `sample-meeting-v1` (status done, rule-written, items migrated) with utterances, speakers, segments, rule minutes, items + sources, one ticked item, in ONE `Storage.transaction`, after native has decoded the audio into the meeting's directory (new `Player.installSample`, `AudioImport.decodeBundled`; `AudioImport.decodeTo` reused). Idempotent: if present it only restores missing audio and un-archives. No schema change; identification is the id prefix `sample-` (`sampleId.ts`, mirrored natively as `AudioRetention.SAMPLE_PREFIX` so the 7-day audio sweep skips it). It never calls the licence module or capture/import, so it cannot take an allowance slot.
   - Library: SAMPLE badge, "See the sample again" row when it is absent, long-press offers only "Delete sample". Excluded from the header count and minutes, the capture streak, the Pro-nudge "completed" count and the open-actions tally. The empty welcome still shows when the sample is the only meeting.
   - Meeting: one-line banner ("This is a sample so you can see the notes before recording. It isn't from your phone's microphone.") with "Delete sample". Opening it no longer spends the once-ever Pro offer.
   - Searchable and labelled, no special-casing beyond the badge, as specified.
3. **Onboarding leads with value.** One primary `Button`: "Set up private recording — 114 MB" (the sum of the catalog's REQUIRED models still to fetch, never the writer). Secondary "See a sample meeting first" opens the seeded sample without a download. Device-fit stays on the first screen via the existing `spaceReason` / `cpuReason` (a disk shortfall replaces the button; an unsupported CPU keeps the existing "Not this phone" screen). Plan choice is gone from the first screen; a small header link with `accessibilityLabel="See Verbale Pro"` opens the existing Paywall. Writer, larger transcriber and "Already subscribed? Sign in" are behind a quiet "More options", shown only for a phone that can run the writer or a subscriber. The done screen shows the one note "Verbale works in English. Free: 5 meetings each month · up to 1 hour each." (English only for Pro), and "Start recording" now `reset`s to Library → Record. If everything is already installed the primary action is "Start recording" at once. A failed essential download offers "Try again" and "Continue without it" with the Library card as the way back.
   - **Readiness card** (Library and Record): `src/setup/`. States unknown / notStarted / downloading / paused / failed / ready from one pure `readiness()`; copy "Finish setup — 28% of 114 MB downloaded" + Resume, "Setup stopped — … Check your connection." + Retry, "Downloading — …", "Finish setup — 114 MB to download" + Download. The download is now one shared run (`essentialDownload.ts`) so progress and failure survive leaving a screen. Native already resumes a model's `.part` with a Range request and skips installed models, so Resume and Retry are the same call; `ModelManager.list()` gained `heldBytes` (finished parts + partial) so a paused download can state its percentage. Disk shortfall and unsupported CPU are handled with the existing wording / no card.
   - The note and card also appear on the Record screen before the first real recording (the sample does not count as one).
   - Not done: "appear … after setup" for More options. After setup the writer remains in Settings and on the Pro screen; the first screen only reveals it for a capable device or a subscriber.

## Script (scripts/sample-meeting/script.txt)

```
Priya|Samantha|Morning Sam, thanks for joining. Let's start the weekly check-in with a quick recap.
Sam|Daniel|Sure. The designs are finished, and testing wrapped up on Tuesday. The only open point is the launch video.
Priya|Samantha|Right. Tell me about the agency quote.
Sam|Daniel|Yes, this morning. The team has looked at it, and nobody had any concerns.
Priya|Samantha|Good. We agreed to go with the agency quote of four thousand five hundred dollars for the launch video.
Sam|Daniel|Great. The agency needs a week to edit, so the video will land close to the launch. Do we need captions on it?
Priya|Samantha|Not sure yet. I will send the signed quote to the agency by Wednesday.
Sam|Daniel|I'll update the help articles by Friday. I will also share the launch checklist today.
Priya|Samantha|Thanks. The review with the support team still needs to be booked before next Monday.
Sam|Daniel|Understood. The store screenshots are finished, so that part is done.
Priya|Samantha|Perfect. That is everything for this week. Thanks Sam.
Sam|Daniel|Thanks Priya. Talk next week.
```

What the extractor produced: 1 decision (with the price), 4 actions (Priya, by Wednesday; Sam, by Friday; Sam, today — shown ticked; one unassigned, "due before next Monday"), 1 open question, and the rule summary. Owners follow the speaker row, so renaming Priya or Sam updates them.

Regenerate: `scripts/make-sample-meeting.sh` (macOS; needs ffmpeg, python3, node, the built CLI and `eval/models`). `WORK=<dir>` keeps intermediates.

## Tests (all pass; full gate `types js scans kotlin` clear: 93 suites, 956 tests)

- `src/sample/__tests__/sampleMeeting.test.ts` (6), `sampleId.test.ts` (2), `seedSample.test.ts` (8), `seedSampleSql.test.ts` (3; the seed's real SQL run in SQLite against the real DDL, with FK cascade).
- `src/setup/__tests__/readiness.test.ts` (15), `ReadinessCard.test.tsx` (8), `essentialDownload.test.ts` (5).
- `src/screens/__tests__/OnboardingScreen.test.tsx` (15), `LibrarySample.test.tsx` (8), `MeetingScreenSample.test.tsx` (5), `RecordScreen.setup.test.tsx` (7); `allowanceCopy.test.ts` +2.
- Kotlin: `AudioRetentionTest.theBundledSampleIsNeverSweptButARealMeetingIs`.

## Mutants (each broken, a named test failed, restored)

- Readiness: paused-when-nothing-held, failed-beats-running, live-figure-can-go-backwards, no-99-clamp, essentials-include-writer, ready-when-any-installed, failed-after-ready, installed-counted-in-size, plus ReadinessCard: resume-not-wired, space-check-removed, cpu-card-shown, button-while-downloading. All killed.
- Sample exclusion: nudge-counts-sample, header-counts-sample, minutes-count-sample, streak-counts-sample, sample-always/never-present, no-sample-badge, empty-hero-hidden-with-sample; `isSampleId` prefix-anywhere, `withoutSample` identity; MeetingScreen sample-spends-pro-offer, no-banner, stay-after-delete; Record sample-spends-first-time, card-while-recording, note-always, note-for-pro-says-allowance; Kotlin `neverSwept` always false. All killed.
- Seed: audio-after-rows, no-reindex, never-unarchive, not-idempotent, done-not-ticked, not-migrated; allowance: touches-licence-ledger, writes-allowance-row. All killed.
- Onboarding: size-includes-writer, start-opens-library, no-allowance-note, pro-link-unlabelled, sample-needs-download, no-retry, no-already-set-up, no-space-reason, more-always-open, failure-swallowed, two-primaries. All killed.
- Sample data: a wrong utteranceId on an item source, and a hand-edited item text, both fail `sampleMeeting.test.ts`.

## Commits and a caution

`3b79664` sample + script; `542ad76` seed, banner, native audio install, retention exemption; `e79258a` readiness card, shared download, `heldBytes`; `8f86728` onboarding, Record, copy. **The Library and MeetingScreen hunks of this work were swept into two other session's commits (`dea65f6`, `5e41d87`, both titled as Trust B reports)** because I had staged them with `git update-index` to keep other builders' hunks out, and a concurrent `git commit` took the shared index. The content is on the branch and tested; only the attribution is wrong. Staging ahead of a commit is unsafe with concurrent builders; stage and commit in one command.

## Left for others / notes

- The sample's actions appear in the Pro worklist (`ActionsScreen`), Search, Ask and Threads like any meeting, labelled only where the Library shows it. Excluding it from the worklist and its "Across N meetings" line needs an edit in `ActionsScreen`/`actionsData`, which this session was told not to touch.
- `ModelManagerModule.heldBytes` is not covered by a JVM test (it reads files); it is exercised only through JS fixtures.
- Backup/restore carries the sample like any meeting.

## Device checks owed (none run)

- Fresh install: first screen shows one primary action with the real catalog size; the sample opens without network; setup then "Start recording" lands on the recorder.
- The sample's audio decodes (`android.resource` copy of the `.m4a` → `MediaExtractor`/`MediaCodec` → PCM) and plays; tapping a source link seeks to the cited sentence; the audio survives the 7-day sweep.
- Kill the app mid-download, reopen: the Library and Record card say "paused", the percentage matches the disk, Resume continues the partial file (Range) rather than restarting. Airplane mode mid-download: card reads "Setup stopped", Retry works.
- Screen reader pass (Pro link, More options expanded state, readiness card, SAMPLE badge, banner), large text, small viewport (the first screen is a ScrollView; confirm the primary action and the sample button are reachable), dark mode.
- Delete the sample from the banner and from the Library long-press; "See the sample again" restores it with audio.
- Opening the sample does not trigger the Pro sheet; the allowance line is unchanged after seeding and opening it.
