# Track A — Headless-MOM Polish (Design)

Date: 2026-08-11
Status: Approved (design)
Branch (to be created): `feat/headless-mom-polish` off `main`

## Context

The headless-MOM feature (merged to `main` at `f0b8229`) makes a stop-from-PiP/notification
produce a full MOM in the background. Three follow-ups remain — all small, independent, and on the
same headless-MOM UX/correctness surface. This is the first of three tracks (A → B → C); B is the
native LLM enhancement port, C is transcribe-during-recording. Each track gets its own spec → plan →
build cycle.

Scope of this spec: the three Track-A items only. Nothing here touches the C++ pipeline or the
native LLM stack.

## Items

### #2 — "Minutes" progress step never animates

**Problem.** `ProcessingEngine.run()` emits `listener.onStage(...)` for `vad`/`asr`/`diarize` but
emits nothing around the minutes block (`ProcessingEngine.kt:151-159`). `MeetingScreen` already
renders a 4th step keyed `minutes` (`STAGES`, `MeetingScreen.tsx:36-41`) and animates whichever step
the latest `onStageProgress` names — so the step exists but is never activated for in-app recordings.

**Change.**
- `ProcessingEngine.kt`: wrap the minutes block with `listener.onStage("minutes", 0, 1)` before and
  `listener.onStage("minutes", 1, 1)` after (i.e. bracket lines 151-159). No other engine change.
- `src/pipeline/types.ts`: add `'minutes'` to the `PipelineStage` union (line ~14) so the stage name
  is typed. `StageProgress.stage` is already loose enough not to error, but the union should be exact.

**Non-goals.** No new event names; reuse the existing `onStage → emitProgress("onStageProgress")`
path (`AudioPipelineBridge.emitProgress`).

**Verification.** Device: record in-app, watch the 4th step ("Pulling out the minutes") animate
before the results view replaces the progress UI.

### #1 — Deep-link "Notes ready" notification → the meeting

**Problem.** `ProcessingService.postNotesReady` already stuffs an `openMeetingId` extra into the
launch `PendingIntent` (`ProcessingService.kt:197-220`), but `MainActivity` (launchMode
`singleTask`) never reads it — the tap just opens the app on whatever screen it was on. There is no
`linking` config on the `NavigationContainer` and no `onNewIntent` override.

**Approach.** Mirror the `Linking.getInitialURL` split — a runtime event for the warm case and a
consumed-once getter for the cold case — reusing the existing native→JS `RCTDeviceEventEmitter` seam
that `emitPipMode()`/`usePipMode` already use.

**Native.**
- A companion holder `object DeepLink { @Volatile var pendingMeetingId: String? = null }` in the
  `MainActivity.kt` file.
- `MainActivity.onCreate`: read the `openMeetingId` intent extra into `DeepLink.pendingMeetingId`
  (cold start).
- `MainActivity.onNewIntent(intent)`: `setIntent(intent)`, read the `openMeetingId` extra, and emit a
  new `"onOpenMeeting"` device event (`{ meetingId }`) via `RCTDeviceEventEmitter` when
  `reactHost?.currentReactContext` is live; if not live yet, fall back to `pendingMeetingId`.
- Add `consumePendingMeetingId(): Promise<String?>` to the existing `AudioPipeline` TurboModule
  (`NativeAudioPipeline` spec + Kotlin module) — returns and clears `pendingMeetingId`. Chosen over a
  new module to avoid extra codegen scaffolding, consistent with app-level methods like
  `recoverOrphans`/`discardAudio` already living there.

**JS.**
- Attach a `navigationRef` (`createNavigationContainerRef<RootStackParamList>()`) to the
  `NavigationContainer` in `RootNavigator`.
- On app mount (once): `const id = await AudioPipeline.consumePendingMeetingId(); if (id)
  navigationRef.navigate('Meeting', { meetingId: id })` (cold start).
- Subscribe to `DeviceEventEmitter` `'onOpenMeeting'` → `navigationRef.navigate('Meeting', {
  meetingId })` (warm start); unsubscribe on unmount.
- Navigate (not reset): pushes `Meeting` on top of the `Library` root so Back returns to Library.

**Edge cases.** Tap while already on a different `Meeting` — `navigate` with new params targets the
same route; acceptable. Tap while recording — just navigates; recording is unaffected (capture is a
separate foreground service).

**Verification.** Device: tap "Notes ready" both cold (app killed) and warm (app backgrounded) →
lands on the correct meeting; Back returns to Library.

### #3 — Regenerate preserves the LLM tier

**Problem.** `SpeakersScreen.regenerate()` (`SpeakersScreen.tsx:42-49`) calls
`PipelineController.buildMinutes`, which unconditionally rewrites all minutes as `source:'rule'`
(`extractMinutes` returns `source:'rule'`; `db.replaceMinutes` deletes+reinserts). A meeting that had
LLM-enhanced minutes (`source:'llm'`) is silently downgraded to the rule floor after a speaker merge.
`source` ('rule'|'llm') is already persisted per row and round-trips through `db.minutes`.

**Change.** Add `PipelineController.regenerateMinutes(meetingId)` that preserves the tier:
1. Read existing minutes; `wasLlm = rows.some(r => r.source === 'llm')`.
2. Rebuild the rule floor with the merged speakers (existing `buildMinutes` logic → `source:'rule'`).
3. If `wasLlm`: chain `enhanceMinutes(meetingId)` — already gated on
   `Llm.available()/capable()/load()` and already falls back to keeping the rule minutes on any
   failure, so a now-unavailable/incapable model degrades gracefully to the rule floor.

`SpeakersScreen.regenerate()` calls `regenerateMinutes` instead of `buildMinutes`. `buildMinutes`
stays as the rule-only primitive (still used internally by `regenerateMinutes`).

**Verification.** jest (extends `__tests__/sweep.test.ts` patterns): a meeting whose stored minutes
include a `source:'llm'` row re-runs `enhanceMinutes` (mocked `Llm`); a `source:'rule'`-only meeting
does not; both perform the merged-speaker rule rebuild.

## Testing summary

- jest: #3 tier-preservation logic (unit, mocked `db` + `Llm`).
- tsc + eslint clean.
- Device: #1 (cold + warm notification tap) and #2 (4th step animates).

## Out of scope

- Native LLM enhancement port (Track B).
- Transcribe-during-recording (Track C).
- React Navigation URL `linking` config / custom scheme (the getter+event pattern is sufficient and
  smaller).
