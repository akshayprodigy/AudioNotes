# Processing feedback — honest ETA, thermal pause, action tracker entry

*Sub-project 2B of the improvement-report work. 16 September 2026. Founder decisions: a learned
ETA with live within-stage progress; pause (and say so) at SEVERE heat or low battery unplugged,
resume on its own; the action tracker reached from a Library card and a header icon.*

Three things a person sees after pressing Stop: how long the wait really is, why it has stopped
moving, and where the actions went. Each is answered today by something wrong or missing: the ETA
is priced from rates measured once on one Pixel and knows only which stage is running; a hot phone
slows down and the screen says nothing; the cross-meeting action tracker exists and nothing in the
app opens it.

## 1. Progress and ETA

**Native.** `NativeBridge.nativeTranscribe` and `nativeDiarize` gain a final argument,
`progress: StageProgress?`:

```kotlin
/** Called from the native thread between units of work. Return false to abort. */
fun interface StageProgress { fun onProgress(done: Int, total: Int): Boolean }
```

JNI wraps it as the core's existing `AsrProgressFn` and `AsrAbortFn` (both passed as `nullptr`
today; the core already calls progress once per window and abort before each) and as sherpa's
`SherpaOnnxOfflineSpeakerDiarizationProgressCallback` (per chunk; sherpa ignores the return
value, so diarization pauses but cannot abort mid-call — cancel takes effect at the stage
boundary, as it does now). A null `progress` behaves exactly as before, so the CLI, the tests
and the live pass are untouched. The core's chunking, decoding and result assembly do not
change: the parity goldens stay the proof.

**Engine.** `ProcessingEngine` passes one callback per stage that forwards
`listener.onStage("asr", done, total)` / `onStage("diarize", done, total)` — the same event the
narrator already sends with real counts, and the same `onStageProgress {chunk, total}` the bridge
already emits. VAD and minutes stay 0/1: seconds long, nothing to report inside.

After each stage the engine writes its measured rate to `settings`:

- key `rate.<stage>` (`vad`, `asr`, `diarize`, `minutes`, `narrate`), value seconds of work per
  second of audio, as text;
- blended: `new = 0.7 × measured + 0.3 × old` when a value exists, `measured` when not — one odd
  run (a hot phone, a live-pass cache that skipped most of ASR) moves the number, not owns it;
- not written when the audio is under 30 s: too little work to price anything;
- not written for a stage that was cancelled or failed.

The blend and the guards live in a pure `StageRates` object with JVM tests. Reading the rates
is one query (`SELECT key, value FROM settings WHERE key LIKE 'rate.%'`), exposed to JS as
`db.stageRates(): Promise<Partial<Record<StageKey, number>>>`.

**Screen.** `progressFor` gains two inputs: `rates` (the phone's, falling back per stage to the
shipped constants, which are the Pixel's 6 Sep measurements) and `fraction` — `done / total`
when the running stage has reported counts, else the current 0.4 guess for a stage that has only
said it started. `pct` and `etaSec` follow: done stages' rates plus the running stage's rate ×
fraction, over the total; remaining is everything not yet done, priced by the audio length as
now (never elapsed time). The stage list shows "Words written down · 14 of 40" on the running
stage when counts exist. `MeetingScreen` reads the rates once per mount alongside the meeting.

**Not in scope:** rates per model (a model change re-learns on its first run); sub-progress for
VAD and minutes; any use of elapsed time.

## 2. Thermal pause

**The rule** is a pure object `ProcessingBudget`, sibling of `LiveBudget`, with the same inputs
(thermal status, battery percent, charging):

```kotlin
enum class PauseReason { HEAT, BATTERY }
/** Why to stop now, or null. `paused` is the reason currently in force, for hysteresis. */
fun reasonToPause(thermal: Int, batteryPercent: Int, charging: Boolean, paused: PauseReason?): PauseReason?
```

Pause at thermal ≥ `THERMAL_STATUS_SEVERE`, or battery < 15 % and not charging. A pause in
force lifts only when thermal ≤ `MODERATE` and (battery ≥ 20 % or charging) — hysteresis, so the
line is not crossed twice a minute. MODERATE alone never pauses: the Pixel reads MODERATE on a
desk while charging, which is what a long meeting looks like (the `LiveBudget` lesson).

**Where it waits.** In the `StageProgress` callback from §1, before it returns: while
`reasonToPause` is non-null it sleeps 5 s and asks again, so ASR pauses between windows and
diarization between chunks — the unit of work in flight always finishes, nothing is lost. Every
stage boundary in `ProcessingEngine` asks the same question, so a pause can begin before VAD,
minutes or the narrator too. Cancel during a pause returns abort immediately. Each pause and
resume is logged with the numbers that caused it (`pause HEAT: thermal=4 battery=61 charging=true`),
the way capture warnings are.

**What people see.** A new bridge event `onProcessingPause {meetingId, reason | null}` (null =
resumed). The processing screen replaces "Writing your notes…" with "Paused to let the phone
cool — it resumes on its own" or "Paused until the phone is charging or has more battery", stops
the ring's animation and hides the ETA while paused. The ProcessingService notification carries
the same line. The Library card's badge reads PAUSED. No button: there is nothing to do but wait
or plug in. On resume the screen returns to the stage list where it was.

**Not in scope:** thread reduction, a user override, pausing the live pass differently than it
already does.

## 3. Action tracker entry

**Library card.** Between the streak card and the first date group: "**7 open actions** · across
4 meetings", with the checklist icon; tap → `Actions`. Hidden when there are no open actions —
a "0 open actions" card is a nag. Counts come from `loadActions()` (the tracker's own loader),
refreshed on focus like the rest of the Library, so a tick made inside a meeting shows on the way
back.

**Header icon.** A checklist `IconButton` between Search and Settings, always present, tap →
`Actions`. Free: provenance and the worklist were decided free on 8 Sep; only interpretation is
Pro.

**The screen** stays as built, with one addition it has lacked since Task 10: tapping a row's
meeting title opens that meeting on its Actions tab — `navigate('Meeting', {meetingId, tab:
'actions'})` — not the Summary.

## 4. Tests

Every new behaviour has a test that fails against the defect it names; every test is
mutation-checked before it is trusted (the house rule).

- `StageRatesTest` (JVM): blend arithmetic; first run writes measured; under-30 s writes nothing;
  a cancelled stage writes nothing.
- `ProcessingBudgetTest` (JVM): SEVERE pauses, MODERATE does not; battery 14 % unplugged pauses,
  14 % charging does not; hysteresis — a HEAT pause holds while SEVERE, lifts at MODERATE; a
  BATTERY pause holds at 17 % unplugged and lifts at 20 %, or at once on charge.
- `progress.test.ts`: rates override constants per stage; fraction from counts drives pct and
  ETA; missing counts fall back to 0.4; a stage at 40 of 40 prices as done.
- `MeetingScreen.test.tsx`: the paused line renders on `onProcessingPause` and the ETA is hidden;
  "14 of 40" renders from a progress event with counts.
- `LibraryScreen.test.tsx`: the card renders with counts and navigates; no open actions, no card;
  the header icon navigates.
- `ActionsScreen.test.tsx`: the meeting title navigates to the Actions tab.
- C++: `test_evidence` and the ASR goldens unchanged (the core does not change); a CLI run with
  `--progress` printing window counts proves the callback fires once per window.
- Device: a 5-minute meeting on the Pixel — the stage row counts up, the ETA falls, the rates
  land in `settings` and the second run's ETA differs from the first; the Library card and icon
  open the tracker; the title opens the Actions tab. The pause is provoked by the developer
  hook Android provides (`adb shell cmd thermalservice override-status 3` (SEVERE)) and cleared with
  `override-status 0` — screen and notification show the paused line, the log shows the pause
  and resume, the transcript is complete.

## Out of scope

Per-model rates; an ETA on the Library card; a "nothing heard" warning; the Quick Settings tile.

## Device verification — Pixel 7 Pro, Android 17, 16 Sep 2026

Release APK over the real library; speech from the Mac's speakers.

**Actions entry.** Library showed "96 open actions · across 11 meetings" with the checklist
icon in the header; tap → the tracker; a tick there, then the meeting title → that meeting on
its **Actions** tab reading "1 of 13 done" (same tick store); back to the Library: "95 open
actions". Header icon → tracker.

**Progress and ETA.** First meeting (335 s): ASR ran 20 s (0.06x — the live pass had cached
it), then "Speakers separated · 70 of 585" counting up through diarization. Second meeting
(206 s), same stage: first meeting's pill read "10% · about 7 min left" on the shipped
constants; the second's read "3% · about 3 min left" from the learned rates — this phone's
`rate.asr` is 0.06–0.21 against a shipped 0.34. Stage log lines now carry the paused time:
`stage=diarize 28293ms (0.28x realtime, 0ms paused)`.

**Pause.** `adb shell cmd thermalservice override-status 3` during diarization → within one
chunk: `pause HEAT: thermal=3 battery=92 charging=true`; the screen: "Paused for a moment /
Paused to let the phone cool — it resumes on its own.", the pill "13%" with no ETA, a pause
glyph on the active row; the Library card badge PAUSED. `override-status 0` → `resume after
110 s`, the card back to TRANSCRIBING, the transcript complete.

**Three defects found in the run, all fixed in-branch.**

1. *The notification did not say paused.* `onStage` now fires per window and per chunk and the
   service rebuilt the notification on every one; Android sheds updates past five a second
   ("Shedding notify (update) … rate limit (5.0) exceeded") and the pause line was among the
   shed. The notification is posted only when its text changes. Re-verified on the second
   meeting: "Paused to let the phone cool — it resumes on its own." in the shade.
2. *A paused stage taught a rate that included the pause.* The first run's diarization sat
   paused 110 s of a 335 s meeting — 0.33x of waiting. `StageRates.measured` now takes the wall
   time net of paused time; mutation-checked.
3. *Delete during diarization wrote speakers for a deleted meeting.* The engine was cancelled
   but sherpa cannot abort mid-call; on return `assignSpeakers` raised FOREIGN KEY constraint
   failed (caught — no crash). Cancelled now writes nothing, the same guard ASR has.

**Not exercised.** ASR window counts on the phone: the live pass caches the whole recording,
so post-hoc ASR finishes in ~20 s and never shows a count worth reading; the callback is the
same one diarization proved and the CLI printed `[asr] 1/2, 2/2` for. An import (no live
cache) is where the ASR count will be visible. Battery pause: unit-tested only; the phone was
on a charger.
