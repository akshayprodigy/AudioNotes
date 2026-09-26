# Phase B — nothing is lost, and nothing false is said — report

**Status: built and gated on the host; not yet run on a phone.** All ten steps (plus Step 4b/B7)
of `docs/superpowers/specs/2026-09-25-phase-b-nothing-lost-nothing-false-execution.md` are done,
every named mutant killed and restored, the full local gate is clear, and a release build compiles.
Device verification is the founder's, per §7 below.

## What was built, per step

- **Step 1** (`72ee651`) — `end_reason`, `fail_reason`, `fail_count`, `announce_outcome` columns on
  `meetings`; `PENDING_MEETINGS_SQL` (the sweep) and `EMPTY_MEETINGS_SQL` (empty-recording deletion)
  exported and tested against real DDL.
- **Step 2** (`42d2b2b`) — status `failed` for a crash; `FailureReason.of(Throwable)` turns an
  exception into a sentence a person can act on; `ResumePlan` resumes a crashed run from where it
  stopped instead of reading it as "no speech".
- **Step 3** (`defc6c9`) — `EndNotice` decides, in one place, what a non-Stop ending stores, whether
  the service can queue it itself, and what the notification says; the free-limit notice no longer
  claims transcription that never started; the tile's Stop now queues too.
- **Step 4** (`38f8c3c`) — the announcement's outcome is stored on every recording and, when it was
  not heard, shown as a capture warning for two minutes.
- **Step 4b / B7** (`a351194`) — `AnnouncementSpan.lagToExclude` keys the ASR exclusion on `found`,
  not `heard`, so a clip loud enough to be heard by whisper but too quiet to count as "heard" is
  still kept out of the transcript (the A07 defect of 25 Sep).
- **Step 5** — Session B1 gate, all clear; `docs(progress)` commit `926a828`.
- **Step 6** (`8307c22`) — `src/screens/meeting/meetingNotes.ts`: `endingNote`, `announceLine`,
  `holdFor` as pure, independently-tested functions.
- **Step 7** (`97238a3`) — MeetingScreen: the empty state is one of four things (`failed`,
  `waiting`, `no-speech`, `no-audio`) decided by `holdFor`, never guessed from a timeout; a `failed`
  meeting shows its reason with **Try again**; **Write it again** (`onRewrite`) no longer calls
  `db.clearNarration` before processing — the old summary stays on screen and in the database until
  `PipelineController.process(id, { force: true })` replaces it in one transaction.
- **Step 8** (`d081080`) — SummaryTab: choosing a type on Pro over an existing summary asks
  `Change to <type>?` before rewriting; Cancel changes nothing; free and "no summary yet" do not ask.
- **Step 9** (`ccd93a3`) — Library shows `DIDN'T FINISH` (not `NO SPEECH`) for a crash, with the
  reason as its subtitle; RecordScreen explains a non-Stop ending it sees live, offering the meeting
  when there is one; Speakers' merge names both speakers and asks via `confirmDestructive` before
  deleting the dropped speaker's row.
- **Step 10** — this report; gate and `assembleRelease` below.

## An extra fix the full gate found

`cce9754` — running the full `js` stage (not just the files each step touched in isolation) surfaced
a pre-existing MeetingScreen test, *"choosing a meeting type writes it and remembers it for the
meeting's tags"*, that called a type-sheet action and asserted `db.setTemplate` was called
synchronously. That test's meeting carries an existing summary and the test licence fixture
defaults to `paid: true`, so Step 8's new asks-first confirm now sits in front of it. The test now
presses **Change** in the confirm before asserting — the wiring itself did not change, only the step
needed to get there. This is a genuine gap in the sheet's own token-discipline read list (§1 names
only lines 1–75 and 450–470 of this file; the affected test was outside both ranges), not a defect
in Step 8's behaviour.

## A note on §6's `clearNarration` grep

§6 says `git grep -n "clearNarration" -- src/screens` should print nothing, but Step 7's own test
instructions (item 1 and the "Write it again" test) explicitly add
`(db.clearNarration as jest.Mock).mockResolvedValue(undefined);` and
`expect(db.clearNarration).not.toHaveBeenCalled();` to
`src/screens/__tests__/MeetingScreen.test.tsx` — a deliberate regression guard proving the old
clear-before-rewrite behaviour is gone. Production code has zero references
(`git grep -n "clearNarration" -- src/screens ':(exclude)*/__tests__/*'` prints nothing); only the
two test-file lines the sheet itself asked for remain. Kept the assertion rather than the literal
grep, since deleting it would remove real coverage to satisfy a bullet that contradicts a more
specific instruction earlier in the same sheet.

## Tests and mutants

| Test | Result | Mutant | Result |
|---|---|---|---|
| SchemaTest (26 columns) | pass | — | — |
| `pendingMeetings.test.ts` (3 tests) | pass | M1: `fail_count < 3` → `< 99` | killed, restored |
| ResumePlanTest (crash resume, 2 tests) | pass | M2: delete `status != "failed"` guard | killed, restored |
| FailureReasonTest (6 tests) | pass | M3: delete `OutOfMemoryError` branch | killed, restored |
| EndNoticeTest (5 tests) | pass | M4: `capturedBytes > 0L` → `>= 0L` | killed, restored |
| CaptureWarningsTest (+2 tests) | pass | M5: `unannouncedShowing` `<` → `<=` | killed, restored |
| AnnouncementSpanTest (+3 tests) | pass | M12: `verdict.found` → `verdict.heard` | killed, restored |
| `meetingNotes.test.ts` (9 tests) | pass | M6: delete `'vad'` from `PENDING` | killed, restored |
| MeetingScreen.test.tsx (32 tests incl. 5 new + 1 amended) | pass | M7: `empty` drops `hold !== 'waiting'` | killed, restored |
| " | " | M8: `onRewrite` `force: true` → `false` | killed, restored |
| SummaryTab.test.tsx (25 tests) | pass | M9: replace the confirm with `change()` | killed, restored |
| LibraryScreen.test.tsx (+1 test) | pass | M10: delete `case 'failed'` in `statusOf` | killed, restored |
| SpeakersScreen.test.tsx (+1 test) | pass | M11: `confirmDestructive` → direct `db.mergeSpeakers().then(load)` | killed, restored |

Twelve mutants (M1–M12) named across both sessions, all killed by their named test and restored.
RecordScreen has no test suite (per the sheet); its change is `tsc`-checked only.

`npx jest src/db --silent` → all passed. `npx jest src/screens --silent --forceExit` → 310 passed,
32 suites. `npx tsc --noEmit` → nothing.

## Gate and release build

`GATE_STAGES="types js scans mutations kotlin cpp" scripts/gate.sh`:

```
==> types    ok  (2s)
==> js       ok  (7s)
==> scans    ok  (4s)
==> mutations ok (76s)
==> kotlin   ok  (2s)
==> cpp      ok  (24s)
gate: all clear in 115s
```

(First run of this session's gate failed at `js` on the pre-existing wiring test above; fixed,
re-run clean.)

`cd android && ./gradlew :app:testDebugUnitTest --rerun-tasks` → `BUILD SUCCESSFUL`.

`cd android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a` →
`BUILD SUCCESSFUL` (warnings only: pre-existing R8 stack-map-table notices in
`play-services-auth`, unrelated to this work).

**Device: not run — founder's by-hand session.** No `adb`, no `connectedDebugAndroidTest`, and the
gate's `device` stage was excluded throughout, per the sheet's rules.

## Verification checklist (§6/§7 targets)

- `git grep -n "setFailure\|onReprocess(true)" -- src` → nothing.
- `git grep -n "notif_cap_reached" -- android` → nothing.
- `git grep -n "clearNarration" -- src/screens ':(exclude)*/__tests__/*'` → nothing (see note above
  for the two intentional test-file lines).
- `git status` clean as of this commit.

## §7 — By hand, for the founder

(a new internal-testing build, version bumped past the Phase A one):

1. **Free limit, screen off.** On Free, start recording and lock the phone; wait past 15 minutes.
   The notification reads *Stopped at the 15-minute Free limit* and EITHER *It is being transcribed
   now.* OR *Open Verbale to transcribe it.* — **note which**: it answers whether Android lets the
   app start processing from the background. Open the app: the meeting processes (or is done)
   without pressing anything, and reads *Stopped at the Free limit. Everything up to that point is
   kept.*
2. **Same, screen on.** Stay on the Record screen past the limit: an alert *Recording stopped* with
   *Open the meeting*.
3. **Tile Stop.** Start a recording, stop it from the Quick Settings tile, do not open the app: a
   *Notes ready* notification arrives in due course.
4. **Announcement not heard.** Media volume to zero, start recording: within seconds the Record
   screen and the notification say *The announcement was not heard — tell the room you are
   recording.*; after about two minutes they stop saying it. The meeting reads *Not announced: the
   phone was on silent.* With the volume up, a new meeting reads *Announced at the start of the
   recording.*
5. **Waiting, not silent.** Record two short meetings back to back and open the second while the
   first is processing: it reads *Writing your notes…* or *Not transcribed yet* with *Process now* —
   never *could not hear any speech*.
6. **Write it again.** On Pro, open a meeting with a summary, tap *Write it again*: the summary
   stays on screen while the button reads *Working…*, and is replaced when the new one is ready.
   Change the type to *Stand-up*: it asks *Change to Stand-up?*; *Cancel* changes nothing; *Change*
   keeps the summary until the stand-up version replaces it.
7. **Merge.** Speakers → merge a speaker: it asks *Merge Speaker 2 into Speaker 1?*; *Cancel* keeps
   both.

## Known gaps

- The background start of processing after a non-Stop ending (`ProcessingService.enqueue` from
  `RecordingService.onDestroy`, and from the tile's Stop) is unverified on a phone — Android may
  refuse a background start under Doze or battery restrictions in ways a JVM test cannot see. §7
  item 1 is written specifically to answer this.
- `ProcessingEngine`'s `markFailed` call (Step 2) has no JVM test: nothing in this sheet can make a
  real processing run crash. Only a device can exercise `FailureReason.of` against a real
  `OutOfMemoryError` or `UnsatisfiedLinkError` from the pipeline itself, rather than one constructed
  by hand in `FailureReasonTest`.
- Step 4b's "not unit-testable" gap carries over unchanged: that `announced_lag_ms` reaches the row
  for a quiet-but-found clip is proved only by re-running the A07 pass (media volume 2, check the
  transcript does not open with "recorded by Verbali").
- `mergeSpeakers`, `mergeSpeakers` has no transaction and writes no `edits` rows (§10 of the sheet);
  unchanged by this session — B6 was the confirm dialog only, as decided.
- §6's "eleven mutants" count is one short of the twelve actually named (M1–M12) across both
  sessions; all twelve are recorded above.

## Full commit log

```
$ git log --oneline 1a23715..HEAD
cce9754 test(meeting): the meeting-type wiring test presses through the new asks-first confirm
ccd93a3 fix(library,record,speakers): a crash reads DIDN'T FINISH; an ending is explained; merging asks first
d081080 fix(summary): changing the meeting type asks before replacing a summary, and saves the type first
97238a3 fix(meeting): "no speech" only when it is; a crash says why with Try again; Write it again keeps the summary
8307c22 feat(meeting): endings, the announcement line and the empty states as plain functions
926a828 docs(progress): Phase B session B1 done
a351194 fix(record): a consent clip found but not heard is kept out of the transcript
38f8c3c feat(record): an announcement nobody heard is stored on the meeting and warned about
defc6c9 fix(record): every ending is stored, queued and explained — the free limit, a lost mic, a full disk, the tile
42d2b2b fix(pipeline): a crash is 'failed' with a reason a person can act on, and runs again
72ee651 feat(db): a failed status, how a recording ended, and the announcement's outcome
acac4fe docs(spec): Phase B gains Step 4b (B7) — a clip found but not heard is kept out of ASR
ba08eef docs(report): H1 built and reviewed — faithful, four mutants killed
ae33b43 fix(billing): a lapsed subscription stops being Pro at the next refresh
155b17f docs(spec): H1 hotfix — lapsed means lapsed — execution sheet
9d63098 docs(plan): fix plan — hotfix, Phase B + clip leak, Phase C device-pass defects, Phase D research
f443c7c docs(report): A07 feature pass on the Play 1.0.3 build — 13 defects, what passed, what was not run
e1a960b build(release): version 1.0.3 (10003) for the Phase A internal-testing upload
85944fa docs(spec): Phase B — nothing lost, nothing false — execution sheet
```
